// public/decoderWorker.js
import { createFFmpeg, fetchFile } from "./ffmpeg.js";

let offscreen, ctx, ffmpeg;

self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    offscreen = data.canvas;
    ctx = offscreen.getContext("2d");

    ffmpeg = createFFmpeg({
      corePath: "./ffmpeg-core.wasm",
      log: true,
    });
    await ffmpeg.load();
    console.log("FFmpeg ready in Worker");
  } else if (data.type === "chunk") {
    const { chunk, recvTime } = data;

    // H.264 덩어리 쓰고
    await ffmpeg.writeFile("input.h264", await fetchFile(chunk));

    // 디코딩 실행
    await ffmpeg.run(
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-i",
      "input.h264",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1"
    );

    // 결과 읽어서 Canvas 렌더링
    const raw = ffmpeg.readFile("pipe:1");
    const imageData = new ImageData(
      new Uint8ClampedArray(raw.buffer),
      offscreen.width,
      offscreen.height
    );
    ctx.putImageData(imageData, 0, 0);

    // 레이턴시 표시
    const latency = (performance.now() - recvTime).toFixed(1);
    ctx.fillStyle = "white";
    ctx.font = "16px sans-serif";
    ctx.fillText(`${latency} ms`, 10, 20);

    // 임시 파일 정리
    ffmpeg.FS.unlink("input.h264");
    ffmpeg.FS.unlink("pipe:1");
  }
};
