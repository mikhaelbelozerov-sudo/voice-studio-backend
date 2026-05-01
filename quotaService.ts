import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Данные из вашего Supabase проекта (замените на свои)
const SUPABASE_URL = 'https://dhubdhpkugfvqgklxzdl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Vm5NiZck3MROCzf1YJXVAw_g8ngEcLE';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export type UserRecord = {
  telegram_id: number;
  subscription_tier: 'free' | 'pro' | 'premium';
  subscription_expires_at: string | null;
  stars_minutes: number;
  language: 'ru' | 'en';
  daily_minutes_used: number;
  last_reset_date: string;
};

/**
 * Получить или создать пользователя в БД по telegramId
 */
export async function getOrCreateUser(telegramId: number, firstName?: string, username?: string): Promise<UserRecord> {
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
    return {
      ...existing,
      stars_minutes: existing.stars_minutes ?? 0,
      subscription_tier: existing.subscription_tier ?? 'free',
      subscription_expires_at: existing.subscription_expires_at ?? null
    } as UserRecord;
  }

  // Создаём нового пользователя
  const { data: newUser, error: insertError } = await supabase
    .from('users')
    .insert([{
      telegram_id: telegramId,
      first_name: firstName || '',
      username: username || '',
      subscription_tier: 'free',
      language: 'ru',
      daily_minutes_used: 0,
      last_reset_date: new Date().toISOString().slice(0,10),
      stars_minutes: 0,
      subscription_expires_at: null
    }])
    .select()
    .single();

  if (insertError) throw insertError;
  return {
    ...newUser,
    stars_minutes: newUser.stars_minutes ?? 0,
    subscription_tier: newUser.subscription_tier ?? 'free',
    subscription_expires_at: newUser.subscription_expires_at ?? null
  } as UserRecord;
}

/**
 * Проверить, может ли пользователь генерировать ещё (не превысил лимит)
 * Для free тарифа — 3 минуты в день (или 3 генерации, зависит от того, что вы хотите)
 * Здесь считаем по количеству генераций (1 генерация = 1 минута, упрощённо)
 */
export function isSubscriptionActive(user: Pick<UserRecord, 'subscription_tier' | 'subscription_expires_at'>): boolean {
  if (user.subscription_tier === 'premium') {
    return true;
  }
  if (user.subscription_tier !== 'pro' || !user.subscription_expires_at) {
    return false;
  }
  return new Date(user.subscription_expires_at).getTime() > Date.now();
}

export async function canGenerate(telegramId: number): Promise<boolean> {
  const user = await getOrCreateUser(telegramId);

  if (isSubscriptionActive(user)) {
    return true;
  }

  if ((user.stars_minutes ?? 0) > 0) {
    return true;
  }

  return user.daily_minutes_used < 3;
}

/**
 * Списать одну генерацию (увеличить счётчик daily_minutes_used)
 */
export async function consumeGeneration(telegramId: number) {
  const user = await getOrCreateUser(telegramId);

  if (isSubscriptionActive(user)) {
    return;
  }

  let error = null;
  if ((user.stars_minutes ?? 0) > 0) {
    const result = await supabase
      .from('users')
      .update({ stars_minutes: Math.max((user.stars_minutes ?? 0) - 1, 0) })
      .eq('telegram_id', telegramId);
    error = result.error;
  } else {
    const newCount = user.daily_minutes_used + 1;
    const result = await supabase
      .from('users')
      .update({ daily_minutes_used: newCount })
      .eq('telegram_id', telegramId);
    error = result.error;
  }

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

export type UserProfile = {
  subscription_tier: SubscriptionTier;
  subscription_expires_at: string | null;
  stars_minutes: number;
  language: 'ru' | 'en';
};

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

export async function getUserProfile(telegramId: number): Promise<UserProfile> {
  const user = await getOrCreateUser(telegramId);
  return {
    subscription_tier: user.subscription_tier ?? 'free',
    subscription_expires_at: user.subscription_expires_at ?? null,
    stars_minutes: user.stars_minutes ?? 0,
    language: (user.language === 'en' ? 'en' : 'ru')
  };
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
      if (!fs.existsSync(tempDir)) {
          console.warn(`⚠️ Cleanup skipped: temp directory does not exist (${tempDir})`);
          return 0;
      }

      // 1) Берем только те генерации, у которых еще не проставлен file_deleted=true
      const { data: generations, error: genError } = await supabase
          .from('generations')
          .select('id, user_telegram_id, audio_url, created_at, file_deleted')
          .not('audio_url', 'is', null)
          .not('file_deleted', 'is', true);

      if (genError) {
          console.error('Failed to fetch generations for cleanup:', genError);
          return 0;
      }

      if (!generations || generations.length === 0) {
          console.log('🧹 Cleanup: no generation records to process');
          return 0;
      }

      const uniqueUserIds = [...new Set(generations.map(g => g.user_telegram_id))];
      const { data: users, error: usersError } = await supabase
          .from('users')
          .select('telegram_id, subscription_tier')
          .in('telegram_id', uniqueUserIds);

      if (usersError) {
          console.error('Failed to fetch users for cleanup:', usersError);
          return 0;
      }

      const userTierMap = new Map<number, string>();
      users?.forEach((u) => userTierMap.set(u.telegram_id, u.subscription_tier ?? 'free'));

      const missingUsers = uniqueUserIds.filter((id) => !userTierMap.has(id));
      if (missingUsers.length > 0) {
          console.warn('⚠️ Cleanup: users not found for telegram_id, defaulting to free:', missingUsers);
      }

      const now = Date.now();
      let deletedCount = 0;
      let markedDeletedWithoutFile = 0;

      for (const gen of generations) {
          const tierRaw = userTierMap.get(gen.user_telegram_id);
          const tier = tierRaw === 'premium' || tierRaw === 'pro' || tierRaw === 'free' ? tierRaw : 'free';
          const maxAgeHours = tier === 'premium' ? null : (tier === 'pro' ? 30 * 24 : 24);

          const createdTime = new Date(gen.created_at).getTime();
          const ageHours = Number.isFinite(createdTime) ? (now - createdTime) / (1000 * 60 * 60) : Number.NaN;
          const shouldDelete = maxAgeHours !== null && Number.isFinite(ageHours) && ageHours > maxAgeHours;

          console.log('🧾 Cleanup item:', {
              generationId: gen.id,
              telegramId: gen.user_telegram_id,
              createdAt: gen.created_at,
              tier,
              ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : 'invalid_date',
              maxAgeHours,
              shouldDelete
          });

          if (!shouldDelete) {
              continue;
          }

          const filename = gen.audio_url?.split('/').pop();
          if (!filename) {
              console.warn(`⚠️ Cleanup: cannot parse filename for generation ${gen.id}, marking as deleted in DB`);
              await supabase.from('generations').update({ file_deleted: true }).eq('id', gen.id);
              markedDeletedWithoutFile++;
              continue;
          }

          const filePath = path.join(tempDir, filename);
          try {
              if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                  deletedCount++;
                  console.log(`🗑️ File deleted: ${filename} (generation ${gen.id})`);
              } else {
                  console.warn(`⚠️ File already missing: ${filename} (generation ${gen.id}), syncing DB flag`);
                  markedDeletedWithoutFile++;
              }

              const { error: updateError } = await supabase
                  .from('generations')
                  .update({ file_deleted: true })
                  .eq('id', gen.id);

              if (updateError) {
                  console.error(`Failed to update file_deleted for generation ${gen.id}:`, updateError);
              }
          } catch (err) {
              console.error(`Error deleting file for generation ${gen.id} (${filename}):`, err);
          }
      }

      console.log(`🧹 Cleanup completed. Removed files: ${deletedCount}, marked deleted without file: ${markedDeletedWithoutFile}`);
      return deletedCount;
  } catch (err) {
      console.error('Unexpected error during cleanup:', err);
      return 0;
  }
}