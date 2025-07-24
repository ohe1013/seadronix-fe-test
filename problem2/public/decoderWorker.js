// decoderWorker.js
const _log = console.log;
console.log = (...args) => {
  self.postMessage({ __log: args });
  _log.apply(console, args);
};

let offscreen, ctx, decoder;
let spsNal, ppsNal; // SPS/PPS NALU (Uint8Array, Annex‑B 포함 0x00000001 start code)

/**
 * Annex‑B 청크에서 SPS(7), PPS(8) NALU 만 골라서 저장
 */
function extractSPSPPS(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset + 4 < data.byteLength) {
    const size = dv.getUint32(offset); // length‑prefixed? (만약 start‑code 형식이면 이 부분 건너뛰세요)
    // **여기서는 이미 start‑code(0x00000001) 형식이라고 가정**
    // 그래서" 직접 검색:
    break;
  }
  // 실제 Annex‑B: 0x00000001 … nalType
  // 간단히 scan for start codes:
  const u8 = new Uint8Array(data);
  for (let i = 0; i < u8.length - 4; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 1) {
      const nalType = u8[i + 4] & 0x1f;
      let j = i + 4;
      while (
        j < u8.length - 4 &&
        !(u8[j] === 0 && u8[j + 1] === 0 && u8[j + 2] === 0 && u8[j + 3] === 1)
      )
        j++;
      const nal = u8.subarray(i, j);
      if (nalType === 7) spsNal = nal;
      if (nalType === 8) ppsNal = nal;
      if (spsNal && ppsNal) break;
    }
  }
}

/**
 * Annex‑B SPS/PPS → AVCC(blob) description 생성
 */
function makeAvcC() {
  // drop start codes (4 bytes) → 실제 NAL 데이터 부분만
  const sps = spsNal.subarray(4),
    pps = ppsNal.subarray(4);
  // avcC box layout (ISO/IEC 14496‑15)
  const cfg = new Uint8Array(7 + 2 + sps.byteLength + 1 + 2 + pps.byteLength);
  let o = 0;
  cfg[o++] = 1; // configurationVersion
  cfg[o++] = sps[1]; // AVCProfileIndication
  cfg[o++] = sps[2]; // profile_compatibility
  cfg[o++] = sps[3]; // AVCLevelIndication
  cfg[o++] = 0xff; // lengthSizeMinusOne (=3)
  cfg[o++] = 0xe1; // numOfSequenceParameterSets (lower 5 bits)=1
  cfg[o++] = (sps.byteLength >> 8) & 0xff;
  cfg[o++] = (sps.byteLength >> 0) & 0xff;
  cfg.set(sps, o);
  o += sps.byteLength;
  cfg[o++] = 1; // numOfPictureParameterSets
  cfg[o++] = (pps.byteLength >> 8) & 0xff;
  cfg[o++] = (pps.byteLength >> 0) & 0xff;
  cfg.set(pps, o);
  return cfg.buffer;
}

self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    offscreen = data.canvas;
    ctx = offscreen.getContext("2d");
    console.log("✅ Worker inited (canvas)", offscreen.width, offscreen.height);
  } else if (data.type === "chunk") {
    const { chunk, recvTime } = data;
    const annex = new Uint8Array(chunk); // server에서 Annex‑B 로 보내고 있다고 가정

    // 1) SPS/PPS 아직 없으면 뽑고 VideoDecoder 구성
    if (!decoder) {
      extractSPSPPS(annex);
      if (!(spsNal && ppsNal)) {
        console.warn("❌ 아직 SPS/PPS 미검출, 기다립니다");
        return;
      }
      const avcc = makeAvcC();
      decoder = new VideoDecoder({
        output: (frame) => {
          // 캔버스에 그리기
          ctx.drawImage(frame, 0, 0);
          // 지연 overlay
          const latency = (performance.now() - frame.timestamp).toFixed(1);
          console.log(latency);
          ctx.fillStyle = "white";
          ctx.font = "16px sans-serif";
          ctx.fillText(`${latency} ms`, 10, 20);
          frame.close();
        },
        error: (e) => console.error("Decoder error:", e),
      });
      console.log(decoder);
      decoder.configure({
        codec:
          "avc1." + // profile + compatibility + level, 예: 64001f
          [
            sps[1].toString(16).padStart(2, "0"),
            sps[2].toString(16).padStart(2, "0"),
            sps[3].toString(16).padStart(2, "0"),
          ].join(""),
        description: avcc,
      });
      console.log("✅ Decoder configured with avcC");
    }

    // 2) EncodedVideoChunk 로 디코딩
    try {
      decoder.decode(
        new EncodedVideoChunk({
          data: annex,
          timestamp: recvTime,
          /* Annex‑B에서 key 여부 판단 */
          type: (annex[4] & 0x1f) === 5 ? "key" : "delta",
        })
      );
    } catch (e) {
      console.error("decode error:", e);
      if (decoder.state === "closed") {
        console.warn("⚠️ decoder closed, 재구성 필요");
        decoder = null;
      }
    }
  }
};
