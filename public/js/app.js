// ===== 全局状态 =====
let ws = null;
let myId = null;
let myName = '';
let myRole = '';
let authToken = localStorage.getItem('authToken') || null;
let selectedContact = null;
let onlineUsers = [];
let conversations = {}; // { userId: [messages] }

// WebRTC
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let callType = null; // 'audio' | 'video'
let isCallInitiator = false;
let isInCall = false;
let callTimerInterval = null;
let callStartTime = null;
let iceCandidatesBuffer = [];
let pendingCallFrom = null;
let pendingCallType = null;
let isMuted = false;
let isVideoOff = false;

// WebRTC 配置
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]
};

// 1080p 高清视频约束
const videoConstraints1080p = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30, max: 60 },
  aspectRatio: 1.777777778,
  facingMode: 'user'
};

// RTC 编码器配置 - 1080p 高清
const rtcEncodingConfig = {
  x: {
    maxBitrate: 4_000_000,       // 4 Mbps
    maxFramerate: 30,
    scaleResolutionDownBy: 1,    // 不缩放，保持原始分辨率
  }
};

// 接收偏好 - 优先高清
const rtcReceiverPrefs = [
  { kind: 'video', preference: 'high' },
  { kind: 'audio', preference: 'high' },
];

// ===== DOM 引用 =====
const $ = (id) => document.getElementById(id);

// ===== API 请求工具 =====
async function api(path, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(`/api/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// ===== 认证功能 =====

// 页面加载时检查登录状态
async function checkSession() {
  if (!authToken) {
    showLoginScreen();
    return;
  }
  try {
    const data = await api('me');
    myName = data.username;
    myRole = data.role;
    enterChat();
  } catch (err) {
    // token 过期或无效
    localStorage.removeItem('authToken');
    authToken = null;
    showLoginScreen();
  }
}

// 显示登录界面
function showLoginScreen() {
  $('loginScreen').classList.remove('hidden');
  $('chatScreen').classList.add('hidden');
  $('adminScreen').classList.add('hidden');
  showLoginForm();
}

// 显示聊天界面
function enterChat() {
  $('loginScreen').classList.add('hidden');
  $('adminScreen').classList.add('hidden');
  $('chatScreen').classList.remove('hidden');
  // 管理员显示管理按钮
  $('adminPanelBtn').style.display = myRole === 'admin' ? 'flex' : 'none';
  // 连接 WebSocket
  connectWebSocket();
  resetChatSelection();
}

// 切换到登录表单
function showLoginForm() {
  $('loginForm').classList.remove('hidden');
  $('registerForm').classList.add('hidden');
}

// 切换到注册表单
function showRegisterForm() {
  $('loginForm').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
}

// 登录
async function handleLogin() {
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;

  if (!username || !password) {
    showToast('请输入用户名和密码');
    return;
  }

  $('loginBtn').disabled = true;
  $('loginBtn').textContent = '登录中...';

  try {
    const data = await api('login', 'POST', { username, password });
    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    myName = data.user.username;
    myRole = data.user.role;
    showToast('登录成功');
    enterChat();
  } catch (err) {
    showToast(err.message);
  } finally {
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = '登录';
  }
}

// 注册
async function handleRegister() {
  const username = $('registerUsername').value.trim();
  const password = $('registerPassword').value;
  const confirm = $('registerPasswordConfirm').value;

  if (!username || !password) {
    showToast('请输入用户名和密码');
    return;
  }
  if (password.length < 6) {
    showToast('密码至少6位');
    return;
  }
  if (password !== confirm) {
    showToast('两次密码不一致');
    return;
  }

  $('registerBtn').disabled = true;
  $('registerBtn').textContent = '注册中...';

  try {
    await api('register', 'POST', { username, password });
    showToast('注册成功，请等待管理员审核');
    // 清空注册表单，切回登录
    $('registerUsername').value = '';
    $('registerPassword').value = '';
    $('registerPasswordConfirm').value = '';
    $('loginUsername').value = username;
    showLoginForm();
  } catch (err) {
    showToast(err.message);
  } finally {
    $('registerBtn').disabled = false;
    $('registerBtn').textContent = '注册';
  }
}

// 退出登录
async function handleLogout() {
  try {
    await api('logout', 'POST');
  } catch {}
  localStorage.removeItem('authToken');
  authToken = null;
  myName = '';
  myRole = '';
  if (ws) { ws.close(); ws = null; }
  // 清空状态
  selectedContact = null;
  onlineUsers = [];
  conversations = {};
  showLoginScreen();
}

// ===== 管理员面板 =====

function showAdminPanel() {
  $('chatScreen').classList.add('hidden');
  $('adminScreen').classList.remove('hidden');
  loadPendingUsers();
  loadAllUsers();
}

// 加载待审核用户
async function loadPendingUsers() {
  try {
    const data = await api('pending-users');
    const list = $('pendingUsersList');
    if (data.users.length === 0) {
      list.innerHTML = '<div class="admin-empty">暂无待审核用户</div>';
      return;
    }
    list.innerHTML = data.users.map(user => `
      <div class="admin-user-item">
        <div class="admin-user-info">
          <div class="admin-user-name">${escapeHtml(user.username)}</div>
          <div class="admin-user-meta">注册于 ${new Date(user.createdAt).toLocaleString('zh-CN')}</div>
        </div>
        <div class="admin-actions">
          <button class="admin-btn admin-btn-approve" onclick="approveUser(${user.id})">通过</button>
          <button class="admin-btn admin-btn-reject" onclick="rejectUser(${user.id})">拒绝</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('加载失败: ' + err.message);
  }
}

// 加载所有用户
async function loadAllUsers() {
  try {
    const data = await api('all-users');
    const list = $('allUsersList');
    if (data.users.length === 0) {
      list.innerHTML = '<div class="admin-empty">暂无用户</div>';
      return;
    }
    const statusMap = {
      'approved': '已通过',
      'pending': '待审核',
      'rejected': '已拒绝'
    };
    list.innerHTML = data.users.map(user => `
      <div class="admin-user-item">
        <div class="admin-user-info">
          <div class="admin-user-name">${escapeHtml(user.username)}</div>
          <div class="admin-user-meta">注册于 ${new Date(user.createdAt).toLocaleString('zh-CN')}</div>
        </div>
        <div class="admin-actions">
          ${user.role === 'admin'
            ? '<span class="admin-user-status admin">管理员</span>'
            : `<span class="admin-user-status ${user.status}">${statusMap[user.status] || user.status}</span>
               ${user.status !== 'approved' ? `<button class="admin-btn admin-btn-approve" onclick="approveUser(${user.id})">通过</button>` : ''}
               ${user.status === 'approved' ? `<button class="admin-btn admin-btn-reject" onclick="rejectUser(${user.id})">禁用</button>` : ''}`
          }
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('加载失败: ' + err.message);
  }
}

// 审核通过用户
async function approveUser(userId) {
  try {
    await api('approve-user', 'POST', { userId });
    showToast('审核已通过');
    loadPendingUsers();
    loadAllUsers();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// 拒绝用户
async function rejectUser(userId) {
  try {
    await api('reject-user', 'POST', { userId });
    showToast('已拒绝该用户');
    loadPendingUsers();
    loadAllUsers();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// ===== 工具函数 =====
function showToast(msg, duration = 2500) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function getAvatarColor(name) {
  const colors = [
    'linear-gradient(135deg, #FF6B6B, #FF8E53)',
    'linear-gradient(135deg, #4ECDC4, #44A08D)',
    'linear-gradient(135deg, #667EEA, #764BA2)',
    'linear-gradient(135deg, #F093FB, #F5576C)',
    'linear-gradient(135deg, #4FACFE, #00F2FE)',
    'linear-gradient(135deg, #43E97B, #38F9D7)',
    'linear-gradient(135deg, #FA709A, #FEE140)',
    'linear-gradient(135deg, #30CFD0, #330867)',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function getInitial(name) {
  return name ? name.charAt(0).toUpperCase() : '?';
}

// ===== WebSocket 连接 =====
async function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws?token=${authToken}`);

  ws.onopen = async () => {
    console.log('WebSocket 已连接');
    // 生成密钥对
    await generateKeyPair();
    ws.send(JSON.stringify({ type: 'set-name', name: myName, publicKey: myPublicKeyBase64 }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    console.log('WebSocket 断开');
    // 仅在已认证时自动重连
    if (authToken) {
      console.log('3秒后重连...');
      setTimeout(connectWebSocket, 3000);
    }
  };

  ws.onerror = (err) => console.error('WebSocket 错误:', err);
}

function sendWS(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ===== 消息处理 =====
async function handleMessage(msg) {
  switch (msg.type) {
    case 'assigned-id':
      myId = msg.id;
      break;

    case 'name-set':
      $('myName').textContent = msg.name;
      $('myAvatar').textContent = getInitial(msg.name);
      $('myAvatar').style.background = getAvatarColor(msg.name);
      break;

    case 'user-list':
      onlineUsers = msg.users.filter(u => u.id !== myId);
      // 为每个在线用户派生共享密钥
      for (const user of onlineUsers) {
        if (user.publicKey && !sharedSecrets[user.id]) {
          try {
            await deriveSharedSecret(user.publicKey, user.id);
            console.log(`已与用户 ${user.name} 建立加密通道`);
          } catch (err) {
            console.error('派生共享密钥失败:', err);
          }
        }
      }
      renderContacts();
      break;

    case 'user-offline':
      if (selectedContact && selectedContact.id === msg.id) {
        selectedContact = null;
        resetChatSelection();
      }
      if (isInCall && pendingCallFrom === msg.id) {
        endCall();
      }
      break;

    case 'private-message':
      receiveMessage(msg.from, msg.name, msg.content, msg.mediaType, msg.timestamp);
      break;

    case 'private-message-sent':
      // 确认消息已发送
      break;

    case 'call-request':
      handleIncomingCall(msg);
      break;

    case 'call-accepted':
      handleCallAccepted(msg);
      break;

    case 'call-rejected':
      handleCallRejected();
      break;

    case 'call-ended':
      handleCallEnded();
      break;

    case 'webrtc-offer':
      handleWebRTCOffer(msg);
      break;

    case 'webrtc-answer':
      handleWebRTCAnswer(msg);
      break;

    case 'webrtc-ice-candidate':
      handleICECandidate(msg);
      break;

    default:
      break;
  }
}

// ===== 联系人列表 =====
function renderContacts() {
  const list = $('contactList');
  const search = $('searchInput').value.toLowerCase();

  const filtered = onlineUsers.filter(u =>
    u.name.toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-contacts">暂无其他在线用户</div>';
    return;
  }

  list.innerHTML = filtered.map(u => {
    const isActive = selectedContact && selectedContact.id === u.id;
    const lastMsg = conversations[u.id]?.slice(-1)[0];
    return `
      <div class="contact-item ${isActive ? 'active' : ''}" onclick="selectContact(${u.id})">
        <div class="contact-avatar" style="background:${getAvatarColor(u.name)}">${getInitial(u.name)}</div>
        <div class="contact-info">
          <div class="contact-name">${u.name}</div>
          <div class="contact-last">${lastMsg ? (lastMsg.mediaType === 'image' ? '[图片]' : lastMsg.mediaType === 'video' ? '[视频]' : (lastMsg.content.startsWith('enc:') ? '[消息]' : lastMsg.content)) : '在线'}</div>
        </div>
        <div class="online-dot"></div>
      </div>
    `;
  }).join('');
}

function selectContact(userId) {
  const user = onlineUsers.find(u => u.id === userId);
  if (!user) return;

  selectedContact = user;
  $('chatPartnerName').textContent = user.name;
  $('chatPartnerStatus').textContent = '在线';
  $('chatPartnerAvatar').textContent = getInitial(user.name);
  $('chatPartnerAvatar').style.background = getAvatarColor(user.name);

  // 启用输入
  $('messageInput').disabled = false;
  $('sendBtn').disabled = false;
  $('imageBtn').disabled = false;
  $('videoSendBtn').disabled = false;
  $('voiceCallBtn').disabled = false;
  $('videoCallBtn').disabled = false;

  // 渲染消息
  renderMessages();
  renderContacts();

  // 移动端：切换到聊天界面
  showChatOnMobile();
}

function showChatOnMobile() {
  const sidebar = document.querySelector('.sidebar');
  const chatArea = document.querySelector('.chat-area');
  if (sidebar) sidebar.classList.add('slide-out');
  if (chatArea) chatArea.classList.add('slide-in');
}

function showContactsOnMobile() {
  const sidebar = document.querySelector('.sidebar');
  const chatArea = document.querySelector('.chat-area');
  if (sidebar) sidebar.classList.remove('slide-out');
  if (chatArea) chatArea.classList.remove('slide-in');
}

function resetChatSelection() {
  selectedContact = null;
  $('chatPartnerName').textContent = '选择一个联系人';
  $('chatPartnerStatus').textContent = '未选择';
  $('chatPartnerAvatar').textContent = '?';
  $('chatPartnerAvatar').style.background = 'linear-gradient(135deg, #BF5AF2, #5856D6)';
  $('messageInput').disabled = true;
  $('sendBtn').disabled = true;
  $('imageBtn').disabled = true;
  $('videoSendBtn').disabled = true;
  $('voiceCallBtn').disabled = true;
  $('videoCallBtn').disabled = true;
  $('messagesContainer').innerHTML = `
    <div class="messages-welcome">
      <div class="welcome-icon">💬</div>
      <p>选择一位联系人开始聊天</p>
      <p class="welcome-hint">支持文字、图片、视频消息及语音/视频通话</p>
    </div>`;
  // 移动端：返回联系人列表
  showContactsOnMobile();
}

// ===== 聊天消息 =====
async function renderMessages() {
  if (!selectedContact) return;
  const msgs = conversations[selectedContact.id] || [];

  if (msgs.length === 0) {
    $('messagesContainer').innerHTML = `
      <div class="messages-welcome">
        <div class="welcome-icon">💬</div>
        <p>开始和 ${selectedContact.name} 聊天吧</p>
      </div>`;
    return;
  }

  // 异步渲染，先显示文字消息，图片视频异步解密
  const htmlParts = msgs.map((m, index) => {
    const isSent = m.from === myId;
    let content = '';

    if (m.mediaType === 'image') {
      const placeholderId = `media-${index}-${Date.now()}`;
      content = `<div id="${placeholderId}" class="media-loading">🔓 解密中...</div>`;
      // 异步解密图片
      if (m.from !== myId) {
        fetchAndDecryptFile(m.content, m.from).then(blobUrl => {
          const el = document.getElementById(placeholderId);
          if (el) el.outerHTML = `<img src="${blobUrl}" alt="图片" onclick="window.open('${blobUrl}','_blank')">`;
        }).catch(() => {
          const el = document.getElementById(placeholderId);
          if (el) el.textContent = '[图片解密失败]';
        });
      } else {
        // 自己发的，content 是原始 URL，直接显示
        content = `<img src="${m.content}" alt="图片" onclick="window.open('${m.content}','_blank')">`;
      }
    } else if (m.mediaType === 'video') {
      const placeholderId = `media-${index}-${Date.now()}`;
      content = `<div id="${placeholderId}" class="media-loading">🔓 解密中...</div>`;
      if (m.from !== myId) {
        fetchAndDecryptFile(m.content, m.from).then(blobUrl => {
          const el = document.getElementById(placeholderId);
          if (el) el.outerHTML = `<video src="${blobUrl}" controls></video>`;
        }).catch(() => {
          const el = document.getElementById(placeholderId);
          if (el) el.textContent = '[视频解密失败]';
        });
      } else {
        content = `<video src="${m.content}" controls></video>`;
      }
    } else {
      content = `<div>${escapeHtml(m.content)}</div>`;
    }

    return `
      <div class="message-row ${isSent ? 'sent' : 'received'}">
        <div>
          ${!isSent ? `<div class="message-sender">${m.name}</div>` : ''}
          <div class="message-bubble">${content}</div>
          <div class="message-meta">${formatTime(m.timestamp)}</div>
        </div>
      </div>`;
  }).join('');

  $('messagesContainer').innerHTML = htmlParts;

  // 滚动到底部
  $('messagesContainer').scrollTop = $('messagesContainer').scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function sendMessage(content, mediaType = 'text') {
  if (!selectedContact) return;

  // 文字消息需要加密，图片/视频的 URL 不加密（文件本身已加密）
  let encryptedContent = content;
  if (mediaType === 'text') {
    try {
      encryptedContent = await encryptText(content, selectedContact.id);
    } catch (err) {
      showToast('加密失败，消息未发送');
      return;
    }
  }

  sendWS({
    type: 'private-message',
    to: selectedContact.id,
    content: encryptedContent,
    mediaType
  });

  // 本地显示（存储明文）
  if (!conversations[selectedContact.id]) conversations[selectedContact.id] = [];
  conversations[selectedContact.id].push({
    from: myId,
    name: myName,
    content,
    mediaType,
    timestamp: Date.now()
  });

  renderMessages();
  renderContacts();
}

async function receiveMessage(fromId, fromName, content, mediaType, timestamp) {
  // 解密内容
  let decryptedContent = content;
  if (mediaType === 'text') {
    try {
      decryptedContent = await decryptText(content, fromId);
    } catch (err) {
      decryptedContent = '[解密失败]';
    }
  }

  if (!conversations[fromId]) conversations[fromId] = [];
  conversations[fromId].push({
    from: fromId,
    name: fromName,
    content: decryptedContent,
    mediaType,
    timestamp
  });

  if (selectedContact && selectedContact.id === fromId) {
    renderMessages();
  } else {
    showToast(`${fromName} 发来一条消息`);
  }
  renderContacts();
}

// ===== 文件发送（加密后上传，无大小限制）=====
async function handleFileSelect(file, mediaType) {
  if (!file || !selectedContact) return;

  const label = mediaType === 'image' ? '图片' : '视频';
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  showToast(`正在加密并上传${label}（${sizeMB}MB）...`, 3000);

  try {
    // 读取文件
    const fileBuffer = await file.arrayBuffer();
    // 加密文件
    const encryptedBuffer = await encryptFile(fileBuffer, selectedContact.id);
    // 创建加密后的 Blob
    const encryptedBlob = new Blob([encryptedBuffer]);

    const formData = new FormData();
    formData.append('file', encryptedBlob, 'encrypted.dat');
    formData.append('mediaType', mediaType);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        showToast(`上传中 ${percent}%`, 1500);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        const res = JSON.parse(xhr.responseText);
        // 直接使用已知的 mediaType，不依赖服务器判断（因为加密文件 mimetype 不准确）
        sendMessage(res.url, mediaType);
        showToast(`${label}发送成功`, 1500);
      } else {
        showToast(`上传失败：${xhr.status}`, 3000);
      }
    };

    xhr.onerror = () => showToast('网络错误，上传失败', 3000);
    xhr.send(formData);
  } catch (err) {
    console.error('文件加密失败:', err);
    showToast('文件加密失败', 3000);
  }
}

// ===== WebRTC 通话 =====
async function startCall(type) {
  if (!selectedContact) return;

  callType = type;
  isCallInitiator = true;

  try {
    // 获取本地媒体流 - 1080p 高清
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: type === 'video' ? videoConstraints1080p : false
    });

    // 创建 PeerConnection
    createPeerConnection();

    // 添加本地轨道
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // 显示通话界面
    showCallScreen(type, selectedContact.name, true);

    // 发送通话请求
    sendWS({
      type: 'call-request',
      to: selectedContact.id,
      callType: type
    });

    $('callStatusText').textContent = '正在呼叫...';

    // 创建 Offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    sendWS({
      type: 'webrtc-offer',
      to: selectedContact.id,
      sdp: offer
    });

  } catch (err) {
    console.error('获取媒体设备失败:', err);
    showToast('无法访问摄像头/麦克风，请检查权限设置');
    cleanupCall();
  }
}

function handleIncomingCall(msg) {
  pendingCallFrom = msg.from;
  pendingCallType = msg.callType;

  // 查找来电者信息
  const caller = onlineUsers.find(u => u.id === msg.from);
  const callerName = caller ? caller.name : '未知用户';

  $('incomingName').textContent = callerName;
  $('incomingType').textContent = msg.callType === 'video' ? '视频通话' : '语音通话';
  $('incomingAvatar').textContent = getInitial(callerName);
  $('incomingAvatar').style.background = getAvatarColor(callerName);

  $('incomingCallModal').classList.remove('hidden');
}

async function acceptCall() {
  $('incomingCallModal').classList.add('hidden');

  callType = pendingCallType;
  isCallInitiator = false;

  // 查找来电者
  const caller = onlineUsers.find(u => u.id === pendingCallFrom);
  const callerName = caller ? caller.name : '用户';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: pendingCallType === 'video' ? videoConstraints1080p : false
    });

    createPeerConnection();
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    showCallScreen(pendingCallType, callerName, false);
    $('callStatusText').textContent = '正在连接...';

    // 接受通话
    sendWS({
      type: 'call-accepted',
      to: pendingCallFrom,
      callType: pendingCallType
    });

  } catch (err) {
    console.error('获取媒体设备失败:', err);
    showToast('无法访问摄像头/麦克风');
    sendWS({ type: 'call-rejected', to: pendingCallFrom });
    cleanupCall();
  }
}

function rejectCall() {
  $('incomingCallModal').classList.add('hidden');
  sendWS({ type: 'call-rejected', to: pendingCallFrom });
  pendingCallFrom = null;
  pendingCallType = null;
}

async function handleCallAccepted(msg) {
  $('callStatusText').textContent = '已连接';
  startCallTimer();
  isInCall = true;
}

function handleCallRejected() {
  showToast('对方拒绝了通话');
  cleanupCall();
}

async function handleWebRTCOffer(msg) {
  if (!peerConnection) {
    // 作为被叫方，PeerConnection 在 acceptCall 时已创建
    // 如果还没创建，在这里创建
    if (!localStream) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: pendingCallType === 'video' ? videoConstraints1080p : false
        });
        createPeerConnection();
        localStream.getTracks().forEach(track => {
          peerConnection.addTrack(track, localStream);
        });
      } catch (err) {
        console.error('获取媒体失败:', err);
        sendWS({ type: 'call-rejected', to: msg.from });
        return;
      }
    }
  }

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));

    // 发送缓冲的 ICE candidates
    if (iceCandidatesBuffer.length > 0) {
      for (const candidate of iceCandidatesBuffer) {
        await peerConnection.addIceCandidate(candidate);
      }
      iceCandidatesBuffer = [];
    }

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    sendWS({
      type: 'webrtc-answer',
      to: msg.from,
      sdp: answer
    });

  } catch (err) {
    console.error('处理 Offer 失败:', err);
  }
}

async function handleWebRTCAnswer(msg) {
  if (peerConnection) {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      $('callStatusText').textContent = '已连接';
      startCallTimer();
      isInCall = true;
    } catch (err) {
      console.error('设置远端描述失败:', err);
    }
  }
}

async function handleICECandidate(msg) {
  if (peerConnection && peerConnection.remoteDescription) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
      console.error('添加 ICE candidate 失败:', err);
    }
  } else {
    iceCandidatesBuffer.push(new RTCIceCandidate(msg.candidate));
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  // 设置接收偏好 - 优先高清
  if (RTCReceiver && rtcReceiverPrefs) {
    try {
      for (const pref of rtcReceiverPrefs) {
        const receiver = peerConnection.addTransceiver(pref.kind);
        receiver.setCodecPreferences && receiver.setCodecPreferences([]);
      }
    } catch (e) {
      console.log('接收器偏好设置跳过:', e);
    }
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendWS({
        type: 'webrtc-ice-candidate',
        to: isCallInitiator ? selectedContact.id : pendingCallFrom,
        candidate: event.candidate
      });
    }
  };

  peerConnection.ontrack = (event) => {
    remoteStream = event.streams[0];
    const remoteVideo = $('remoteVideo');
    remoteVideo.srcObject = remoteStream;
    // 强制高清播放
    remoteVideo.style.width = '100%';
    remoteVideo.style.height = '100%';
    remoteVideo.style.objectFit = 'cover';
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('连接状态:', state);
    if (state === 'connected') {
      $('callStatusText').textContent = '已连接';
      if (!callTimerInterval) startCallTimer();
      // 连接建立后提升编码器码率
      applyHighQualityEncoding();
    } else if (state === 'disconnected' || state === 'failed') {
      showToast('通话连接中断');
      endCall();
    }
  };
}

// 连接建立后提升编码器参数到 1080p
function applyHighQualityEncoding() {
  if (!peerConnection) return;

  const senders = peerConnection.getSenders();
  for (const sender of senders) {
    if (sender.track && sender.track.kind === 'video') {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      // 设置 1080p 高清编码参数
      params.encodings[0].maxBitrate = 4_000_000;        // 4 Mbps
      params.encodings[0].maxFramerate = 30;
      params.encodings[0].scaleResolutionDownBy = 1;     // 不缩放
      // 优先级设为高
      params.priority = 'high';
      params.degradationPreference = 'maintain-resolution'; // 网络差时优先保持分辨率
      sender.setParameters(params).catch(e => {
        console.log('设置编码参数失败:', e);
      });
      console.log('已应用 1080p 高清编码参数');
    }
    if (sender.track && sender.track.kind === 'audio') {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = 128_000; // 128 kbps 音频
      params.priority = 'high';
      sender.setParameters(params).catch(() => {});
    }
  }
}

function showCallScreen(type, name, isInitiator) {
  $('callScreen').classList.remove('hidden');

  if (type === 'video') {
    $('call-videos')?.classList.remove('hidden');
    $('audioCallView').classList.add('hidden');
    $('remoteVideo').classList.remove('hidden');
    $('localVideo').classList.remove('hidden');
    $('localVideo').srcObject = localStream;
    $('videoToggleBtn').style.display = 'flex';
  } else {
    $('audioCallView').classList.remove('hidden');
    $('remoteVideo').classList.add('hidden');
    $('localVideo').classList.add('hidden');
    $('videoToggleBtn').style.display = 'none';
  }

  $('callName').textContent = name;
  $('callAvatar').textContent = getInitial(name);
  $('callAvatar').style.background = getAvatarColor(name);
  $('callTimer').textContent = '00:00';
}

function startCallTimer() {
  callStartTime = Date.now();
  callTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    $('callTimer').textContent = formatDuration(elapsed);
  }, 1000);
}

function endCall() {
  if (selectedContact || pendingCallFrom) {
    const targetId = isCallInitiator ? selectedContact?.id : pendingCallFrom;
    if (targetId) {
      sendWS({ type: 'call-ended', to: targetId });
    }
  }
  handleCallEnded();
}

function handleCallEnded() {
  cleanupCall();
}

function cleanupCall() {
  isInCall = false;
  isCallInitiator = false;
  isMuted = false;
  isVideoOff = false;

  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  remoteStream = null;
  iceCandidatesBuffer = [];

  $('remoteVideo').srcObject = null;
  $('localVideo').srcObject = null;
  $('callScreen').classList.add('hidden');

  pendingCallFrom = null;
  pendingCallType = null;

  // 重置按钮状态
  $('muteBtn').classList.remove('active');
  $('videoToggleBtn').classList.remove('active');
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $('muteBtn').classList.toggle('active', isMuted);
}

function toggleVideo() {
  if (!localStream || callType !== 'video') return;
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
  $('videoToggleBtn').classList.toggle('active', isVideoOff);
  $('localVideo').classList.toggle('hidden', isVideoOff);
}

// ===== 事件绑定 =====
function bindEvents() {
  // ===== 登录/注册 =====
  $('loginBtn').addEventListener('click', handleLogin);
  $('loginPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  $('registerBtn').addEventListener('click', handleRegister);
  $('registerPasswordConfirm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleRegister();
  });

  $('switchToRegisterBtn').addEventListener('click', showRegisterForm);
  $('switchToLoginBtn').addEventListener('click', showLoginForm);

  // ===== 管理员面板 =====
  $('adminPanelBtn').addEventListener('click', showAdminPanel);
  $('adminEnterChatBtn').addEventListener('click', enterChat);
  $('adminLogoutBtn').addEventListener('click', handleLogout);

  // ===== 退出登录 =====
  $('logoutBtn').addEventListener('click', handleLogout);

  // ===== 聊天功能 =====
  // 搜索
  $('searchInput').addEventListener('input', renderContacts);

  // 发送文字
  $('sendBtn').addEventListener('click', () => {
    const text = $('messageInput').value.trim();
    if (text && selectedContact) {
      sendMessage(text, 'text');
      $('messageInput').value = '';
    }
  });

  $('messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('sendBtn').click();
    }
  });

  // 发送图片
  $('imageBtn').addEventListener('click', () => $('imageFileInput').click());
  $('imageFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFileSelect(file, 'image');
    e.target.value = '';
  });

  // 发送视频
  $('videoSendBtn').addEventListener('click', () => $('videoFileInput').click());
  $('videoFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFileSelect(file, 'video');
    e.target.value = '';
  });

  // 语音通话
  $('voiceCallBtn').addEventListener('click', () => {
    if (selectedContact && !isInCall) startCall('audio');
  });

  // 视频通话
  $('videoCallBtn').addEventListener('click', () => {
    if (selectedContact && !isInCall) startCall('video');
  });

  // 通话控制
  $('muteBtn').addEventListener('click', toggleMute);
  $('videoToggleBtn').addEventListener('click', toggleVideo);
  $('hangupBtn').addEventListener('click', endCall);

  // 来电弹窗
  $('acceptCallBtn').addEventListener('click', acceptCall);
  $('rejectCallBtn').addEventListener('click', rejectCall);

  // 移动端返回按钮
  $('backBtn').addEventListener('click', () => {
    showContactsOnMobile();
  });

  // 窗口关闭时清理
  window.addEventListener('beforeunload', () => {
    if (isInCall) endCall();
    if (ws) ws.close();
  });
}

// ===== 初始化 =====
bindEvents();
checkSession();
