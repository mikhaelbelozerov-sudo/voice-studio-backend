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

app.post(
  ["/generate", "/api/generate"],
  async (req: Request<unknown, unknown, GenerateRequestBody>, res: Response) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
    }

    const { text, voiceId, speed, pitch } = req.body;

    if (!text || !voiceId) {
      return res.status(400).json({ error: "text and voiceId are required" });
    }

    if (text.length > 1000) {
      return res.status(400).json({ error: "Text must be 1000 characters or less" });
    }

    await fs.mkdir(TEMP_DIR, { recursive: true });

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          speed: typeof speed === "number" ? speed : 1,
          pitch: typeof pitch === "number" ? pitch : 1
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: "Failed to generate audio",
        details: errorText
      });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const fileName = `voice_${Date.now()}.mp3`;
    const filePath = path.join(TEMP_DIR, fileName);

    await fs.writeFile(filePath, audioBuffer);

    return res.json({ url: `/temp/${fileName}` });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error while generating audio",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
  }
);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
