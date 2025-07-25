// server.js
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
const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".mp4": "video/mp4",
};

const server = http.createServer((req, res) => {
  const clean =
    req.url.split("?")[0] === "/" ? "/onlyVideo.html" : req.url.split("?")[0];
  const fp = path.join(PUBLIC_DIR, clean);
  fs.stat(fp, (e, s) => {
    if (e || !s.isFile()) return res.writeHead(404).end("404");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(fp)] || "application/octet-stream",
    });
    fs.createReadStream(fp).pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: "/stream" });
wss.on("connection", (ws, req) => {
  const src = new URL(req.url, `http://${req.headers.host}`).searchParams.get(
    "src"
  );
  if (!src || !/^https?:\/\//.test(src)) {
    ws.close(1008, "Invalid src");
    return;
  }

  let ff,
    currentSeek = 0;
  const ffmpegBin = join(
    __dirname,
    "tools",
    "ffmpeg",
    "bin",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  );

  function startFFmpeg() {
    // (1) 이전 프로세스 있으면 종료
    if (ff) ff.kill("SIGINT");

    // (2) -ss 옵션을 앞에 두면 입력 시작 이전에 seek (fast but less accurate)
    const args = [
      "-ss",
      `${currentSeek}`, // 여기를 갱신하면서 재생
      "-re",
      "-i",
      src,
      "-an",
      "-c:v",
      "copy",
      "-bsf:v",
      "h264_mp4toannexb",
      "-f",
      "h264",
      "pipe:1",
    ];
    ff = spawn(ffmpegBin, args);

    ff.stdout.on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    ff.stderr.on("data", (msg) => console.error("ffmpeg:", msg.toString()));
    ff.on("error", (e) => console.error("ffmpeg spawn err:", e));
    ff.on("close", () => {
      // 소켓이 아직 살아 있으면 알아서 닫아도 무방
    });
  }

  // 최초 스트리밍 시작
  startFFmpeg();

  // 클라이언트로부터 seek 요청 처리
  ws.on("message", (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (m.type === "seek" && typeof m.time === "number") {
        console.log("→ seek to", m.time);
        currentSeek = m.time;
        startFFmpeg();
      }
    } catch {}
  });

  ws.on("close", () => {
    if (ff) ff.kill("SIGINT");
  });
});

server.listen(PORT, () => {
  console.log(`HTTP → http://localhost:${PORT}`);
  console.log(`WS     → ws://localhost:${PORT}/stream?src=<VIDEO_URL>`);
});
