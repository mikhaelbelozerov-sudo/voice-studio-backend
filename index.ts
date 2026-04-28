import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { promises as fs } from "fs";
import path from "path";

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
  console.log('📥 Received generate request:', req.body);
  
  // Простейшая заглушка — возвращаем ссылку на тестовое аудио
  // Если вы услышите эту мелодию, значит связь работает
  return res.json({
      audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      status: 'completed'
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
