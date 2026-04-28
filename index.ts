import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { promises as fs } from "fs";
import path from "path";

import { ElevenLabsClient } from 'elevenlabs-node';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid'; // если нет пакета uuid, установите: npm install uuid @types/uuid

// ========== ЭТО ВАШ ОСНОВНОЙ КОД СЕРВЕРА (не копируйте отсюда, только обработчик) ==========
// Ниже только обработчик POST /api/generate. Остальные части (app.use, app.get /voices и т.д.) оставьте как есть.

dotenv.config();

const app = express();
const PORT = 3001;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TEMP_DIR = path.join(__dirname, "temp");

app.use(cors());
app.use(express.json());
app.use("/temp", express.static(TEMP_DIR));

app.get(["/voices", "/api/voices"], async (_req: Request, res: Response) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
    }

    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: "Failed to fetch voices",
        details: errorText
      });
    }

    const voices = await response.json();
    return res.json(voices);
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error while fetching voices",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

interface GenerateRequestBody {
  text: string;
  voiceId: string;
  speed?: number;
  pitch?: number;
}

app.post('/api/generate', async (req, res) => {
  try {
      const { text, voiceId, speed = 1.0, pitch = 0 } = req.body;
      
      // Валидация
      if (!text || !voiceId) {
          return res.status(400).json({ error: 'Missing text or voiceId' });
      }
      if (text.length > 1000) {
          return res.status(400).json({ error: 'Text too long (max 1000 chars)' });
      }

      // Инициализация клиента ElevenLabs
      const client = new ElevenLabsClient({
          apiKey: process.env.ELEVENLABS_API_KEY,
      });

      // Генерация аудиопотока
      const audioStream = await client.generate({
          voice: voiceId,
          text: text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
              stability: 0.7,
              similarity_boost: 0.7,
              speed: parseFloat(speed),
              pitch: parseFloat(pitch)
          }
      });

      // Создаём уникальное имя файла
      const filename = `generated_${uuidv4()}.mp3`;
      const filePath = path.join(__dirname, 'temp', filename);
      
      // Убеждаемся, что папка temp существует
      if (!fs.existsSync(path.join(__dirname, 'temp'))) {
          fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
      }

      // Сохраняем поток в файл
      const writer = fs.createWriteStream(filePath);
      audioStream.pipe(writer);
      
      await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
      });

      // Формируем публичный URL для доступа к файлу
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const audioUrl = `${baseUrl}/temp/${filename}`;

      res.json({
          audioUrl: audioUrl,
          status: 'completed'
      });

  } catch (error) {
      console.error('Generation error:', error);
      res.status(500).json({ error: 'Failed to generate audio. Check ElevenLabs key or text length.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
