import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;  // 👈 ОБЪЯВЛЯЕМ ПОРТ

app.use(cors());
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
    res.status(500).json({ error: error.message });
  }
});

// ===================== СООБЩЕНИЯ =====================

app.post('/api/messages', async (req, res) => {
  try {
    const { user_id, username, text, media_url, media_type } = req.body;

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
        media_type: media_type || null
      }])
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
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
    res.status(500).json({ error: error.message });
  }
});

// ===================== ЗАПУСК =====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 http://0.0.0.0:${PORT}`);
});
