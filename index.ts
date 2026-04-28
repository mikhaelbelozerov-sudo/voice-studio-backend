import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TEMP_DIR = path.join(__dirname, "temp");

// Проверка ключа ElevenLabs
if (!ELEVENLABS_API_KEY) {
    console.error("❌ ELEVENLABS_API_KEY is not set");
    process.exit(1);
}

// Создание папки temp, если её нет
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use("/temp", express.static(TEMP_DIR));

// Получение списка голосов
app.get(["/voices", "/api/voices"], async (_req: Request, res: Response) => {
    try {
        const response = await fetch("https://api.elevenlabs.io/v1/voices", {
            method: "GET",
            headers: { "xi-api-key": ELEVENLABS_API_KEY! }
        });
        if (!response.ok) {
            throw new Error(`ElevenLabs API error: ${response.status}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Генерация аудио (прямой API, без дополнительных пакетов)
app.post("/api/generate", async (req: Request, res: Response) => {
    try {
        const { text, voiceId, speed = 1.0, pitch = 0 } = req.body;
        if (!text || !voiceId) {
            return res.status(400).json({ error: "Missing text or voiceId" });
        }
        if (text.length > 1000) {
            return res.status(400).json({ error: "Text too long (max 1000 chars)" });
        }

        // Вызов ElevenLabs API
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "xi-api-key": ELEVENLABS_API_KEY!
            },
            body: JSON.stringify({
                text: text,
                model_id: "eleven_turbo_v2",
                voice_settings: {
                    stability: 0.7,
                    similarity_boost: 0.7,
                    speed: parseFloat(String(speed)),
                    pitch: parseFloat(String(pitch))
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`ElevenLabs error (${response.status}): ${errorText}`);
        }

        // Получаем аудио как Buffer
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const filename = `generated_${Date.now()}.mp3`;
        const filePath = path.join(TEMP_DIR, filename);
        await fs.promises.writeFile(filePath, buffer);

        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const audioUrl = `${baseUrl}/temp/${filename}`;
        res.json({ audioUrl, status: "completed" });
    } catch (err: any) {
        console.error("Generation error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});