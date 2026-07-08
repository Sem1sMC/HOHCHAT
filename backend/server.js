import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

console.log('🔍 Checking environment variables:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing');
console.log('SUPABASE_KEY:', process.env.SUPABASE_KEY ? '✅ Set' : '❌ Missing');
console.log('PORT:', process.env.PORT || 5000);

const app = express();
const port = process.env.PORT || 5000;

// Настройка CORS - разрешаем все запросы
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Проверка подключения к Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

// Тестовый эндпоинт
app.get('/api/test', (req, res) => {
    res.json({ message: 'API is working!' });
});

// Регистрация пользователя
app.post('/api/auth/register', async (req, res) => {
    try {
        console.log('📝 Registration attempt:', req.body.email);
        const { email, password, username } = req.body;

        const { data: existingUser } = await supabase
            .from('profiles')
            .select('username')
            .eq('username', username)
            .single();

        if (existingUser) {
            return res.status(400).json({ error: 'Username already taken' });
        }

        const { data, error } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { username }
        });

        if (error) {
            console.error('❌ Registration error:', error);
            throw error;
        }

        console.log('✅ User registered:', data.user.id);
        res.status(201).json({
            message: 'User registered successfully',
            user: {
                id: data.user.id,
                email: data.user.email,
                username: username
            }
        });
    } catch (error) {
        console.error('❌ Registration error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Вход пользователя
app.post('/api/auth/login', async (req, res) => {
    try {
        console.log('🔐 Login attempt:', req.body.email);
        const { email, password } = req.body;

        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            console.error('❌ Login error:', error);
            throw error;
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', data.user.id)
            .single();

        await supabase
            .from('profiles')
            .update({ status: 'online', last_seen: new Date() })
            .eq('id', data.user.id);

        console.log('✅ User logged in:', data.user.id);
        res.json({
            user: {
                id: data.user.id,
                email: data.user.email,
                ...profile
            },
            session: data.session
        });
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// Выход
app.post('/api/auth/logout', async (req, res) => {
    try {
        const { user_id } = req.body;
        
        await supabase
            .from('profiles')
            .update({ status: 'offline', last_seen: new Date() })
            .eq('id', user_id);

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получение профиля пользователя
app.get('/api/user/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', req.params.id)
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Настройка multer для загрузки файлов
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});

// Загрузка медиафайла
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        console.log('📤 Uploading file...');
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const file = req.file;
        const fileExt = path.extname(file.originalname);
        const fileName = `${uuidv4()}${fileExt}`;
        const filePath = `uploads/${fileName}`;

        let mediaType = 'image';
        if (file.mimetype.startsWith('video/')) mediaType = 'video';
        else if (file.mimetype.startsWith('audio/')) mediaType = 'audio';
        else if (file.mimetype === 'image/gif') mediaType = 'gif';

        const { data, error } = await supabase.storage
            .from('chat-media')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                cacheControl: '3600'
            });

        if (error) {
            console.error('❌ Upload error:', error);
            throw error;
        }

        const { data: urlData } = supabase.storage
            .from('chat-media')
            .getPublicUrl(filePath);

        console.log('✅ File uploaded:', fileName);
        res.json({
            url: urlData.publicUrl,
            mediaType,
            fileName: file.originalname,
            fileSize: file.size
        });
    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Отправка сообщения
app.post('/api/messages', async (req, res) => {
    try {
        console.log('📨 Sending message:', req.body);
        const { user_id, username, text, media_url, media_type, file_name, file_size } = req.body;

        // Проверяем обязательные поля
        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        // Если username не передан, пытаемся получить его из профиля
        let finalUsername = username;
        if (!finalUsername) {
            console.log('🔍 Username not provided, fetching from profile...');
            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('username')
                .eq('id', user_id)
                .single();

            if (profileError) {
                console.error('❌ Error fetching profile:', profileError);
                // Если не удалось получить username, используем ID
                finalUsername = `user_${user_id.substring(0, 8)}`;
            } else {
                finalUsername = profile.username;
            }
            console.log('✅ Username fetched:', finalUsername);
        }

        // Проверяем, есть ли хоть какой-то контент
        if (!text && !media_url) {
            return res.status(400).json({ error: 'Message must have text or media' });
        }

        const messageData = {
            user_id,
            username: finalUsername,
            text: text || '',
            media_url: media_url || null,
            media_type: media_type || null,
            file_name: file_name || null,
            file_size: file_size || null
        };

        console.log('📨 Inserting message:', messageData);

        const { data, error } = await supabase
            .from('messages')
            .insert([messageData])
            .select()
            .single();

        if (error) {
            console.error('❌ Message insert error:', error);
            throw error;
        }

        console.log('✅ Message sent:', data.id);
        res.status(201).json(data);
    } catch (error) {
        console.error('❌ Send message error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Получение сообщений
app.get('/api/messages', async (req, res) => {
    try {
        console.log('📋 Fetching messages...');
        const { limit = 100 } = req.query;
        
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('❌ Fetch error:', error);
            throw error;
        }

        console.log(`✅ Fetched ${data.length} messages`);
        res.json(data.reverse());
    } catch (error) {
        console.error('❌ Get messages error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Получение новых сообщений
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

// Получение списка пользователей онлайн
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

// Обновление статуса пользователя
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

// Функция для поиска свободного порта
const startServer = (port) => {
    const server = app.listen(port, () => {
        console.log(`✅ Server running on port ${port}`);
        console.log(`📍 http://localhost:${port}`);
        console.log(`🧪 Test API: http://localhost:${port}/api/test`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`⚠️ Port ${port} is busy, trying ${port + 1}...`);
            startServer(port + 1);
        } else {
            console.error('❌ Server error:', err);
        }
    });
};

// Запускаем сервер
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 http://0.0.0.0:${PORT}`);
});