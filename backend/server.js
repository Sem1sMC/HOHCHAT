import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ===================== НАСТРОЙКА =====================

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ===================== WEBSOCKET ДЛЯ ГОЛОСОВЫХ КАНАЛОВ =====================

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Храним подключения пользователей
const clients = new Map();
// Храним участников голосовых каналов
const voiceChannels = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const userId = url.searchParams.get('userId');

  if (userId) {
    clients.set(userId, ws);
    console.log(`✅ Пользователь ${userId} подключен к WebSocket`);
    
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'WebSocket connected',
      userId
    }));
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`📨 Получено от ${data.userId || 'unknown'}:`, data.type);

      switch (data.type) {
        // ===== ГОЛОСОВЫЕ КАНАЛЫ =====
        case 'join_voice_channel': {
          const { channelId, userId, username } = data;
          
          // Добавляем пользователя в канал
          if (!voiceChannels.has(channelId)) {
            voiceChannels.set(channelId, new Map());
          }
          const channel = voiceChannels.get(channelId);
          channel.set(userId, { username, ws });

          // Уведомляем всех участников канала
          broadcastToChannel(channelId, {
            type: 'user_joined',
            userId: userId,
            username: username,
            participants: Array.from(channel.keys())
          }, userId);

          console.log(`👤 ${username} присоединился к каналу ${channelId}`);
          break;
        }

        case 'leave_voice_channel': {
          const { channelId, userId } = data;
          
          if (voiceChannels.has(channelId)) {
            const channel = voiceChannels.get(channelId);
            channel.delete(userId);
            
            broadcastToChannel(channelId, {
              type: 'user_left',
              userId: userId,
              participants: Array.from(channel.keys())
            });

            if (channel.size === 0) {
              voiceChannels.delete(channelId);
            }
          }
          console.log(`👋 Пользователь ${userId} покинул канал`);
          break;
        }

        case 'speaking_status': {
          const { channelId, userId, isSpeaking } = data;
          broadcastToChannel(channelId, {
            type: 'speaking_status',
            userId: userId,
            isSpeaking: isSpeaking
          });
          break;
        }

        // ===== WEBRTC СИГНАЛИНГ =====
        case 'offer':
        case 'answer':
        case 'candidate': {
          const { targetUserId } = data;
          if (targetUserId && clients.has(targetUserId)) {
            const targetWs = clients.get(targetUserId);
            if (targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify({
                type: data.type,
                from: data.userId,
                fromUsername: data.fromUsername,
                offer: data.offer,
                answer: data.answer,
                candidate: data.candidate
              }));
            }
          }
          break;
        }

        case 'get_channel_participants': {
          const { channelId } = data;
          if (voiceChannels.has(channelId)) {
            const channel = voiceChannels.get(channelId);
            ws.send(JSON.stringify({
              type: 'channel_participants',
              channelId: channelId,
              participants: Array.from(channel.keys())
            }));
          }
          break;
        }

        default:
          console.log('📨 Неизвестный тип:', data.type);
      }
    } catch (error) {
      console.error('❌ Ошибка WebSocket:', error);
    }
  });

  ws.on('close', () => {
    // Удаляем пользователя из всех каналов
    for (const [channelId, channel] of voiceChannels) {
      if (channel.has(userId)) {
        channel.delete(userId);
        broadcastToChannel(channelId, {
          type: 'user_left',
          userId: userId
        });
        if (channel.size === 0) {
          voiceChannels.delete(channelId);
        }
      }
    }

    // Удаляем из списка клиентов
    for (const [id, client] of clients.entries()) {
      if (client === ws) {
        clients.delete(id);
        console.log(`👋 Пользователь ${id} отключился`);
        break;
      }
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket ошибка:', error);
  });
});

// Функция для рассылки в канал
function broadcastToChannel(channelId, data, excludeUserId = null) {
  if (!voiceChannels.has(channelId)) return;
  
  const channel = voiceChannels.get(channelId);
  const message = JSON.stringify(data);
  
  for (const [userId, userData] of channel) {
    if (userId !== excludeUserId && userData.ws.readyState === WebSocket.OPEN) {
      userData.ws.send(message);
    }
  }
}

// ===================== АВТОРИЗАЦИЯ =====================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username } = req.body;

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username }
    });

    if (error) throw error;

    await supabase.from('profiles').insert([{
      id: data.user.id,
      username
    }]);

    res.json({ success: true, user: data.user });
  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    await supabase
      .from('profiles')
      .update({ status: 'online' })
      .eq('id', data.user.id);

    res.json({
      user: { ...data.user, ...profile },
      session: data.session
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const { user_id } = req.body;
    await supabase
      .from('profiles')
      .update({ status: 'offline' })
      .eq('id', user_id);
    
    // Отключаем WebSocket
    if (clients.has(user_id)) {
      const ws = clients.get(user_id);
      ws.close();
      clients.delete(user_id);
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================== ФАЙЛЫ =====================

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileExt = path.extname(file.originalname);
    const fileName = `${uuidv4()}${fileExt}`;
    const filePath = `uploads/${fileName}`;

    let mediaType = 'image';
    if (file.mimetype.startsWith('video/')) mediaType = 'video';
    else if (file.mimetype.startsWith('audio/')) mediaType = 'audio';
    else if (file.mimetype === 'image/gif') mediaType = 'gif';

    const { error } = await supabase.storage
      .from('chat-media')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype
      });

    if (error) throw error;

    const { data } = supabase.storage
      .from('chat-media')
      .getPublicUrl(filePath);

    res.json({
      url: data.publicUrl,
      mediaType,
      fileName: file.originalname,
      fileSize: file.size
    });
  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===================== СООБЩЕНИЯ =====================

app.post('/api/messages', async (req, res) => {
  try {
    const { user_id, username, text, media_url, media_type, file_name, file_size } = req.body;

    if (!user_id || !username) {
      return res.status(400).json({ error: 'user_id and username required' });
    }

    const { data, error } = await supabase
      .from('messages')
      .insert([{
        user_id,
        username,
        text: text || '',
        media_url: media_url || null,
        media_type: media_type || null,
        file_name: file_name || null,
        file_size: file_size || null
      }])
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const { limit = 100 } = req.query;

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('❌ Get messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/messages/since/:timestamp', async (req, res) => {
  try {
    const { timestamp } = req.params;

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .gt('created_at', timestamp)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('❌ Get new messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===================== ПОЛЬЗОВАТЕЛИ =====================

app.get('/api/users/online', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('status', 'online')
      .order('username');

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('❌ Get online users error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/user/status', async (req, res) => {
  try {
    const { user_id, status } = req.body;

    const { data, error } = await supabase
      .from('profiles')
      .update({ status, last_seen: new Date() })
      .eq('id', user_id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('❌ Update status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===================== СТАТУС WEBSOCKET =====================

app.get('/api/ws/status', (req, res) => {
  const channels = {};
  for (const [channelId, channel] of voiceChannels) {
    channels[channelId] = Array.from(channel.keys());
  }
  
  res.json({
    wsConnected: true,
    clientsCount: clients.size,
    voiceChannels: channels
  });
});

// ===================== ЗАПУСК =====================

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 HTTP: http://0.0.0.0:${PORT}`);
  console.log(`📍 WebSocket: ws://0.0.0.0:${PORT}`);
  console.log(`📊 Online users: ${clients.size}`);
});
