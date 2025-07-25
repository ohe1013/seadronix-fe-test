// audioWorker.js
let audioDecoder;
onmessage = async ({ data }) => {
  const { timestamp, chunk } = data;
  if (!audioDecoder) {
    audioDecoder = new AudioDecoder({
      output: (frame) => {
        // 디코딩된 오디오 프레임만 워커 → 메인으로 전송
        postMessage({ type: "audio-frame", frame }, [
          frame.allocationSize ? frame : frame,
        ]);
      },
      error: (e) => console.error(e),
    });
    audioDecoder.configure({
      codec: "mp4a.40.2",
      sampleRate: 48000,
      numberOfChannels: 2,
    });
  }
  audioDecoder.decode(
    new EncodedAudioChunk({
      type: "key",
      timestamp,
      data: chunk,
    })
  );
};
