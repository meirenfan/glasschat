// ===== 全局状态 =====
let ws = null;
let myId = null;
let myName = '';
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

// WebRTC 配置 - 使用公共 STUN 服务器
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

// ===== DOM 引用 =====
const $ = (id) => document.getElementById(id);

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
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    console.log('WebSocket 已连接');
    ws.send(JSON.stringify({ type: 'set-name', name: myName }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    console.log('WebSocket 断开，3秒后重连...');
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => console.error('WebSocket 错误:', err);
}

function sendWS(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ===== 消息处理 =====
function handleMessage(msg) {
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
          <div class="contact-last">${lastMsg ? (lastMsg.mediaType === 'image' ? '[图片]' : lastMsg.mediaType === 'video' ? '[视频]' : lastMsg.content) : '在线'}</div>
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
function renderMessages() {
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

  $('messagesContainer').innerHTML = msgs.map(m => {
    const isSent = m.from === myId;
    let content = '';

    if (m.mediaType === 'image') {
      content = `<img src="${m.content}" alt="图片" onclick="window.open('${m.content}','_blank')">`;
    } else if (m.mediaType === 'video') {
      content = `<video src="${m.content}" controls></video>`;
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

  // 滚动到底部
  $('messagesContainer').scrollTop = $('messagesContainer').scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sendMessage(content, mediaType = 'text') {
  if (!selectedContact) return;

  sendWS({
    type: 'private-message',
    to: selectedContact.id,
    content,
    mediaType
  });

  // 本地显示
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

function receiveMessage(fromId, fromName, content, mediaType, timestamp) {
  if (!conversations[fromId]) conversations[fromId] = [];
  conversations[fromId].push({
    from: fromId,
    name: fromName,
    content,
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

// ===== 文件发送（HTTP 上传，无大小限制）=====
function handleFileSelect(file, mediaType) {
  if (!file || !selectedContact) return;

  const label = mediaType === 'image' ? '图片' : '视频';
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  showToast(`正在上传${label}（${sizeMB}MB）...`, 3000);

  const formData = new FormData();
  formData.append('file', file);

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
      // 发送的是文件 URL，消息体很小
      sendMessage(res.url, res.mediaType);
      showToast(`${label}发送成功`, 1500);
    } else {
      showToast(`上传失败：${xhr.status}`, 3000);
    }
  };

  xhr.onerror = () => showToast('网络错误，上传失败', 3000);
  xhr.send(formData);
}

// ===== WebRTC 通话 =====
async function startCall(type) {
  if (!selectedContact) return;

  callType = type;
  isCallInitiator = true;

  try {
    // 获取本地媒体流
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video'
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
      audio: true,
      video: pendingCallType === 'video'
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
          audio: true,
          video: pendingCallType === 'video'
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
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('连接状态:', state);
    if (state === 'connected') {
      $('callStatusText').textContent = '已连接';
      if (!callTimerInterval) startCallTimer();
    } else if (state === 'disconnected' || state === 'failed') {
      showToast('通话连接中断');
      endCall();
    }
  };
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
  // 登录
  $('joinBtn').addEventListener('click', () => {
    const name = $('nameInput').value.trim();
    if (!name) {
      showToast('请输入昵称');
      return;
    }
    myName = name;
    $('loginScreen').classList.add('hidden');
    $('chatScreen').classList.remove('hidden');
    connectWebSocket();
  });

  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('joinBtn').click();
  });

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
$('nameInput').focus();
