import { createClient } from '@supabase/supabase-js';

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