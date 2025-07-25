import http from "http";
import fs from "fs";
import path, { dirname, join } from "path";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");
const PORT = 3000;

// MIME 타입 맵
const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".mp4": "video/mp4",
};

// 1) HTTP 서버: public 폴더 정적 서빙
const server = http.createServer((req, res) => {
  const clean =
    req.url.split("?")[0] === "/"
      ? "/reFlagServer.html"
      : req.url.split("?")[0];
  const fp = path.join(PUBLIC_DIR, clean);
  fs.stat(fp, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404).end("404 Not Found");
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    fs.createReadStream(fp).pipe(res);
  });
});

// 2) WebSocket 서버: A/V 멀티플렉스
const wss = new WebSocketServer({ server, path: "/stream" });
wss.on("connection", (ws, req) => {
  const src = new URL(req.url, `http://${req.headers.host}`).searchParams.get(
    "src"
  );
  if (!src || !/^https?:\/\//.test(src)) {
    ws.close(1008, "Invalid src");
    return;
  }

  let ff; // ffmpeg 프로세스 하나만 사용
  let currentSeek = 0;
  const ffmpegBin = join(
    __dirname,
    "tools",
    "ffmpeg",
    "bin",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  );

  function startFFmpeg() {
    if (ff) ff.kill("SIGINT");

    // ✨ 하나의 FFmpeg 프로세스로 비디오와 오디오를 동시에 처리
    ff = spawn(
      ffmpegBin,
      [
        "-ss",
        `${currentSeek}`, // 시작 시간 설정은 한 번만
        "-re",
        "-i",
        src,
        // 비디오 스트림 설정 (pipe:4로 보냄)
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-bsf:v",
        "h264_mp4toannexb",
        "-f",
        "h264",
        "pipe:4",
        // 오디오 스트림 설정 (pipe:5로 보냄)
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] }
    );

    // ▶ 비디오 스트림 처리 (ff.stdio[4])
    ff.stdio[4].on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) {
        const tsBuf = Buffer.alloc(8);
        tsBuf.writeBigUInt64BE(BigInt(Date.now()));
        const header = Buffer.concat([Buffer.from([1]), tsBuf]); // type=1
        ws.send(Buffer.concat([header, chunk]));
      }
    });

    // // ▶ 오디오 스트림 처리 (ff.stdio[5])
    // ff.stdio[5].on("data", (chunk) => {
    //   if (ws.readyState === ws.OPEN) {
    //     // ✨ 오디오에도 동일하게 타임스탬프 추가!
    //     const tsBuf = Buffer.alloc(8);
    //     tsBuf.writeBigUInt64BE(BigInt(Date.now()));
    //     const header = Buffer.concat([Buffer.from([2]), tsBuf]); // type=2
    //     ws.send(Buffer.concat([header, chunk]));
    //   }
    // });

    ff.stderr.on("data", (msg) => console.error("ffmpeg:", msg.toString()));
    ff.on("close", () => console.log("ffmpeg process stopped"));
  }

  // 최초 스트림 시작
  startFFmpeg();

  // 클라이언트 seek 요청 처리
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "seek" && typeof msg.time === "number") {
        console.log("→ seek to", msg.time);
        currentSeek = msg.time;
        startFFmpeg();
      }
    } catch {}
  });

  ws.on("close", () => {
    if (ffVideo) ffVideo.kill("SIGINT");
    if (ffAudio) ffAudio.kill("SIGINT");
  });
});

// 서버 실행
server.listen(PORT, () => {
  console.log(`HTTP  ▶ http://localhost:${PORT}`);
  console.log(`WS     ▶ ws://localhost:${PORT}/stream?src=<VIDEO_URL>`);
});
