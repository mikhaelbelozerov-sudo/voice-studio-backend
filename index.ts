import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { ElevenLabsClient } from "elevenlabs-node"; // убедитесь, что пакет установлен

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TEMP_DIR = path.join(__dirname, "temp"); // если __dirname работает, иначе замените на 'temp'

// Проверка наличия ключа ElevenLabs
if (!ELEVENLABS_API_KEY) {
    console.error("❌ ELEVENLABS_API_KEY is not set in environment variables");
    process.exit(1); // остановить сервер, если ключа нет
}

// Создаём папку temp, если её нет
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use("/temp", express.static(TEMP_DIR));

// Получение списка голосов (работало и раньше)
app.get(["/voices", "/api/voices"], async (_req: Request, res: Response) => {
    try {
        const response = await fetch("https://api.elevenlabs.io/v1/voices", {
            method: "GET",
            headers: { "xi-api-key": ELEVENLABS_API_KEY }
        });
        if (!response.ok) {
            const errorText = await response.text();
            return res.status(response.status).json({ error: "Failed to fetch voices", details: errorText });
        }
        const voices = await response.json();
        return res.json(voices);
    } catch (error) {
        return res.status(500).json({ error: "Unexpected error", details: String(error) });
    }
});

// Генерация аудио
app.post('/api/generate', async (req: Request, res: Response) => {
    try {
        const { text, voiceId, speed = 1.0, pitch = 0 } = req.body;
        if (!text || !voiceId) {
            return res.status(400).json({ error: 'Missing text or voiceId' });
        }
        if (text.length > 1000) {
            return res.status(400).json({ error: 'Text too long (max 1000 chars)' });
        }

        const client = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
        const audioStream = await client.generate({
            voice: voiceId,
            text: text,
            model_id: 'eleven_monolingual_v1',
            voice_settings: {
                stability: 0.7,
                similarity_boost: 0.7,
                speed: parseFloat(String(speed)),
                pitch: parseFloat(String(pitch))
            }
        });

        const filename = `generated_${uuidv4()}.mp3`;
        const filePath = path.join(TEMP_DIR, filename);
        const writer = fs.createWriteStream(filePath);
        audioStream.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const audioUrl = `${baseUrl}/temp/${filename}`;
        res.json({ audioUrl, status: 'completed' });
    } catch (error) {
        console.error('Generation error:', error);
        res.status(500).json({ error: 'Failed to generate audio. Check ElevenLabs key or text length.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});