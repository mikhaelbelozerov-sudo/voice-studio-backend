import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Данные из вашего Supabase проекта (замените на свои)
const SUPABASE_URL = 'https://dhubdhpkugfvqgklxzdl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Vm5NiZck3MROCzf1YJXVAw_g8ngEcLE';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Получить или создать пользователя в БД по telegramId
 */
export async function getOrCreateUser(telegramId: number, firstName?: string, username?: string) {
  // Проверяем, есть ли уже такой пользователь
  const { data: existing, error: fetchError } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 = нет записей
    throw new Error(`User fetch error: ${fetchError.message}`);
  }

  if (existing) {
    // Проверяем, нужно ли сбросить daily_minutes_used (если last_reset_date != сегодня)
    const today = new Date().toISOString().slice(0,10);
    if (existing.last_reset_date !== today) {
      const { error: updateError } = await supabase
        .from('users')
        .update({ daily_minutes_used: 0, last_reset_date: today })
        .eq('telegram_id', telegramId);
      if (updateError) throw updateError;
      existing.daily_minutes_used = 0;
      existing.last_reset_date = today;
    }
    return existing;
  }

  // Создаём нового пользователя
  const { data: newUser, error: insertError } = await supabase
    .from('users')
    .insert([{
      telegram_id: telegramId,
      first_name: firstName || '',
      username: username || '',
      subscription_tier: 'free',
      daily_minutes_used: 0,
      last_reset_date: new Date().toISOString().slice(0,10)
    }])
    .select()
    .single();

  if (insertError) throw insertError;
  return newUser;
}

/**
 * Проверить, может ли пользователь генерировать ещё (не превысил лимит)
 * Для free тарифа — 3 минуты в день (или 3 генерации, зависит от того, что вы хотите)
 * Здесь считаем по количеству генераций (1 генерация = 1 минута, упрощённо)
 */
export async function canGenerate(telegramId: number): Promise<boolean> {
  const user = await getOrCreateUser(telegramId);
  if (user.subscription_tier === 'pro') {
    // Для pro-пользователей лимита нет (или очень большой)
    return true;
  }
  // free: не более 3 генераций в день
  return user.daily_minutes_used < 3;
}

/**
 * Списать одну генерацию (увеличить счётчик daily_minutes_used)
 */
export async function consumeGeneration(telegramId: number) {
  const user = await getOrCreateUser(telegramId);
  const newCount = user.daily_minutes_used + 1;
  const { error } = await supabase
    .from('users')
    .update({ daily_minutes_used: newCount })
    .eq('telegram_id', telegramId);
  if (error) throw error;
}

/**
 * Сохранить информацию о генерации в историю
 */
export async function saveGenerationHistory(
  telegramId: number,
  text: string,
  voiceId: string,
  audioUrl: string
) {
  const { error } = await supabase
    .from('generations')
    .insert([{
      user_telegram_id: telegramId,
      text: text,
      voice_id: voiceId,
      audio_url: audioUrl,
      created_at: new Date().toISOString()
    }]);
  if (error) console.error('Failed to save generation:', error);
}

export type GenerationHistoryItem = {
  id: number | string;
  text: string | null;
  voice_id: string | null;
  audio_url: string | null;
  created_at: string;
  file_deleted: boolean | null;
};

export type SubscriptionTier = 'free' | 'pro' | 'premium';

export async function getUserSubscriptionTier(telegramId: number): Promise<SubscriptionTier> {
  const { data, error } = await supabase
    .from('users')
    .select('subscription_tier')
    .eq('telegram_id', telegramId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`User tier fetch error: ${error.message}`);
  }

  const tier = data?.subscription_tier;
  if (tier === 'pro' || tier === 'premium') {
    return tier;
  }

  return 'free';
}

export async function getUserGenerations(
  telegramId: number,
  limit = 20,
  offset = 0
): Promise<GenerationHistoryItem[]> {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const { data, error } = await supabase
    .from('generations')
    .select('id, text, voice_id, audio_url, created_at, file_deleted')
    .eq('user_telegram_id', telegramId)
    .order('created_at', { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);

  if (error) {
    throw new Error(`Generations fetch error: ${error.message}`);
  }

  return (data ?? []) as GenerationHistoryItem[];
}

type GenerationWithUserTier = {
  id: number | string;
  audio_url: string | null;
  created_at: string;
  users?: { subscription_tier?: string | null } | Array<{ subscription_tier?: string | null }> | null;
};

/**
 * Удаляет просроченные аудиофайлы с учетом тарифа пользователя.
 *
 * Требуется поле в БД:
 * ALTER TABLE generations ADD COLUMN IF NOT EXISTS file_deleted boolean DEFAULT false;
 */
export async function cleanExpiredFiles(tempDir: string): Promise<number> {
  try {
      // 1. Получаем все записи из generations, у которых есть audio_url
      const { data: generations, error: genError } = await supabase
          .from('generations')
          .select('id, user_telegram_id, audio_url, created_at')
          .not('audio_url', 'is', null);

      if (genError) {
          console.error('Failed to fetch generations for cleanup:', genError);
          return 0;
      }

      if (!generations || generations.length === 0) {
          console.log('Нет записей для проверки');
          return 0;
      }

      // 2. Получаем уникальные telegram_id пользователей
      const uniqueUserIds = [...new Set(generations.map(g => g.user_telegram_id))];
      
      // 3. Запрашиваем тарифы для этих пользователей
      const { data: users, error: usersError } = await supabase
          .from('users')
          .select('telegram_id, subscription_tier')
          .in('telegram_id', uniqueUserIds);

      if (usersError) {
          console.error('Failed to fetch users for cleanup:', usersError);
          return 0;
      }

      // Создаём map: telegram_id -> subscription_tier
      const userTierMap = new Map();
      users?.forEach(u => userTierMap.set(u.telegram_id, u.subscription_tier));

      const now = Date.now();
      let deletedCount = 0;

      for (const gen of generations) {
          const tier = userTierMap.get(gen.user_telegram_id) || 'free';
          let maxAgeHours = null;
          if (tier === 'free') maxAgeHours = 24;
          else if (tier === 'pro') maxAgeHours = 30 * 24; // 720 часов
          // premium – null, никогда не удаляем

          if (maxAgeHours !== null) {
              const createdTime = new Date(gen.created_at).getTime();
              const ageHours = (now - createdTime) / (1000 * 60 * 60);
              if (ageHours > maxAgeHours) {
                  // Извлекаем имя файла из audio_url
                  const filename = gen.audio_url.split('/').pop();
                  if (filename) {
                      const filePath = path.join(tempDir, filename);
                      try {
                          if (fs.existsSync(filePath)) {
                              fs.unlinkSync(filePath);
                              deletedCount++;
                              console.log(`🗑️ Удалён файл: ${filename} (пользователь ${gen.user_telegram_id}, тариф ${tier}, возраст ${Math.round(ageHours)} ч.)`);
                              
                              // Обновляем запись в generations – помечаем файл удалённым
                              await supabase
                                  .from('generations')
                                  .update({ file_deleted: true })
                                  .eq('id', gen.id);
                          }
                      } catch (err) {
                          console.error(`Ошибка удаления файла ${filename}:`, err);
                      }
                  }
              }
          }
      }
      console.log(`🧹 Cleanup completed. Removed files: ${deletedCount}`);
      return deletedCount;
  } catch (err) {
      console.error('Unexpected error during cleanup:', err);
      return 0;
  }
}