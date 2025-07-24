// server.js
import http from "http";
import fs from "fs";
import path, { dirname, join } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = 3000;

// MIME 타입 맵
const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".mp4": "video/mp4",
};

// HTTP 서버: public 폴더 정적 제공
const server = http.createServer((req, res) => {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/stream.html";
  const fp = path.join(PUBLIC_DIR, urlPath);

  fs.stat(fp, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404 Not Found");
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    fs.createReadStream(fp).pipe(res);
  });
});
const ffmpegBin = join(
  __dirname,
  "tools",
  "ffmpeg",
  "bin",
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
);
// WebSocket 서버: fMP4 fragment 송출
const wss = new WebSocketServer({ server, path: "/stream" });
wss.on("connection", (ws, req) => {
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const src = params.get("src");
  const format = params.get("format");

  if (!src || format !== "fmp4") {
    ws.close(1008, "Invalid src or format");
    return;
  }

  // ffmpeg 프로세스 시작
  const ffmpeg = spawn(ffmpegBin, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    src,
    "-c",
    "copy",
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "pipe:1",
  ]);
  function sendPacket(type, chunk) {
    // 1바이트 type + 8바이트 서버 시각(ms)
    const tsBuf = Buffer.alloc(8);
    tsBuf.writeBigUInt64BE(BigInt(Date.now()), 0);
    ws.send(Buffer.concat([Buffer.from([type]), tsBuf, chunk]));
  }
  ffmpeg.stdout.on("data", (chunk) => {
    if (ws.readyState === ws.OPEN) sendPacket(1, chunk);
  });
  ffmpeg.stderr.on("data", (msg) => {
    console.error("ffmpeg error:", msg.toString());
  });

  // 연결 종료 시 프로세스 정리
  const cleanup = () => {
    if (!ffmpeg.killed) ffmpeg.kill("SIGINT");
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

server.listen(PORT, () => {
  console.log(`HTTP ▶ http://localhost:${PORT}`);
  console.log(
    `WS   ▶ ws://localhost:${PORT}/stream?format=fmp4&src=<VIDEO_URL>`
  );
});
