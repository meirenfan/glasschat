const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// WebSocket 不限制消息大小，支持大文件元数据传输
const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 0 });

// 上传文件存储目录
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// multer 配置：文件上传，无大小限制
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const name = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: Infinity } // 无大小限制
});

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 文件上传接口（图片/视频，无大小限制）
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到文件' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  const mediaType = req.file.mimetype.startsWith('image/') ? 'image'
                  : req.file.mimetype.startsWith('video/') ? 'video'
                  : 'file';
  res.json({ url: fileUrl, mediaType, size: req.file.size });
});

// 存储所有连接的客户端
const clients = new Map();
let clientIdCounter = 0;

wss.on('connection', (ws) => {
  const clientId = ++clientIdCounter;
  const userInfo = { id: clientId, name: '', ws };

  clients.set(clientId, userInfo);
  console.log(`用户 ${clientId} 已连接，当前在线: ${clients.size}`);

  // 发送分配的ID
  ws.send(JSON.stringify({ type: 'assigned-id', id: clientId }));

  // 广播在线用户列表
  broadcastUserList();

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'set-name':
        userInfo.name = msg.name || `用户${clientId}`;
        ws.send(JSON.stringify({ type: 'name-set', name: userInfo.name }));
        broadcastUserList();
        break;

      case 'chat-message':
        // 广播聊天消息给所有人
        broadcast({
          type: 'chat-message',
          from: clientId,
          name: userInfo.name,
          content: msg.content,
          mediaType: msg.mediaType || 'text',
          timestamp: Date.now()
        }, ws);
        break;

      case 'private-message':
        // 私聊消息
        const targetUser = clients.get(msg.to);
        if (targetUser) {
          targetUser.ws.send(JSON.stringify({
            type: 'private-message',
            from: clientId,
            name: userInfo.name,
            content: msg.content,
            mediaType: msg.mediaType || 'text',
            timestamp: Date.now()
          }));
          ws.send(JSON.stringify({
            type: 'private-message-sent',
            to: msg.to,
            content: msg.content,
            mediaType: msg.mediaType || 'text',
            timestamp: Date.now()
          }));
        }
        break;

      // WebRTC 信令转发
      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'webrtc-ice-candidate':
      case 'call-request':
      case 'call-accepted':
      case 'call-rejected':
      case 'call-ended':
        forwardToTarget(msg, ws);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`用户 ${clientId} 已断开，当前在线: ${clients.size}`);
    // 通知所有人该用户离线
    broadcast({
      type: 'user-offline',
      id: clientId
    });
    broadcastUserList();
  });
});

function broadcast(message, excludeWs) {
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.ws !== excludeWs && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  });
}

function broadcastUserList() {
  const userList = [];
  clients.forEach((client) => {
    userList.push({ id: client.id, name: client.name || `用户${client.id}` });
  });
  broadcast({ type: 'user-list', users: userList });
}

function forwardToTarget(msg, senderWs) {
  const target = clients.get(msg.to);
  if (target && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(JSON.stringify({
      ...msg,
      from: getClientIdByWs(senderWs)
    }));
  }
}

function getClientIdByWs(ws) {
  for (const [id, info] of clients) {
    if (info.ws === ws) return id;
  }
  return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 GlassChat 服务器已启动`);
  console.log(`📱 访问地址: http://localhost:${PORT}`);
  console.log(`💡 提示: 在两个浏览器标签页中打开以测试通话功能\n`);
});
