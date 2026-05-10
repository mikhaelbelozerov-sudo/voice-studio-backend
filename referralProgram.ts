import crypto from "crypto";
import type { Request } from "express";
import { supabase } from "./supabaseClient";
import { logAnalyticsEvent } from "./creditEconomy";

export const REFERRAL_INVITEE_BONUS_CREDITS = 30;
export const REFERRAL_INVITER_BONUS_CREDITS = 60;
export const REFERRAL_MONTHLY_REWARD_CAP = 10;
const DELAY_MIN_MS = 5 * 60 * 1000;
const DELAY_MAX_MS = 10 * 60 * 1000;

export type ReferralStatus = "pending" | "activated" | "rewarded" | "rejected" | "flagged";

function randomGrantDelayMs(): number {
  return DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
}

function monthStartIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
}

export function hashReferralIp(req: Request): string | null {
  const raw =
    (typeof req.headers["x-forwarded-for"] === "string" && req.headers["x-forwarded-for"].split(",")[0]?.trim()) ||
    req.socket?.remoteAddress ||
    "";
  if (!raw) {
    return null;
  }
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

async function countInviterPaidThisMonth(referrerTelegramId: number): Promise<number> {
  const start = monthStartIso();
  const { count, error } = await supabase
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_telegram_id", referrerTelegramId)
    .eq("legacy_row", false)
    .not("referrer_bonus_paid_at", "is", null)
    .gte("referrer_bonus_paid_at", start);

  if (error) {
    return 0;
  }
  return count ?? 0;
}

/** Process due credits for rows where this user is invitee or referrer. */
export async function processDueReferralRewards(telegramId: number): Promise<void> {
  const now = new Date().toISOString();

  const { data: asInvitee } = await supabase
    .from("referrals")
    .select("*")
    .eq("invitee_telegram_id", telegramId)
    .not("invitee_bonus_due_at", "is", null)
    .lte("invitee_bonus_due_at", now)
    .is("invitee_bonus_paid_at", null)
    .in("status", ["pending", "activated"])
    .eq("legacy_row", false)
    .eq("fraud_flag", false);

  for (const row of asInvitee ?? []) {
    const { data: user } = await supabase.from("users").select("credit_balance").eq("telegram_id", telegramId).single();
    const bal = Number(user?.credit_balance ?? 0);
    const { error: upErr } = await supabase
      .from("users")
      .update({ credit_balance: bal + REFERRAL_INVITEE_BONUS_CREDITS })
      .eq("telegram_id", telegramId);
    if (upErr) {
      continue;
    }
    await supabase
      .from("referrals")
      .update({
        invitee_bonus_paid_at: now,
        status: "activated"
      })
      .eq("id", row.id);
    void logAnalyticsEvent(telegramId, "referral_reward_granted", { role: "invitee", credits: REFERRAL_INVITEE_BONUS_CREDITS });
  }

  const { data: asReferrer } = await supabase
    .from("referrals")
    .select("*")
    .eq("referrer_telegram_id", telegramId)
    .not("referrer_bonus_due_at", "is", null)
    .lte("referrer_bonus_due_at", now)
    .is("referrer_bonus_paid_at", null)
    .eq("legacy_row", false)
    .not("first_generation_at", "is", null)
    .not("download_ack_at", "is", null);

  for (const row of asReferrer ?? []) {
    if (row.status === "rejected" || row.status === "flagged") {
      continue;
    }
    const paidThisMonth = await countInviterPaidThisMonth(telegramId);
    if (paidThisMonth >= REFERRAL_MONTHLY_REWARD_CAP) {
      await supabase
        .from("referrals")
        .update({
          status: "flagged",
          fraud_flag: true,
          fraud_reason: "monthly_invite_cap"
        })
        .eq("id", row.id);
      void logAnalyticsEvent(telegramId, "referral_limit_reached", { referralId: row.id });
      continue;
    }

    const { data: inviter } = await supabase.from("users").select("credit_balance").eq("telegram_id", telegramId).single();
    const bal = Number(inviter?.credit_balance ?? 0);
    const { error: upErr } = await supabase
      .from("users")
      .update({ credit_balance: bal + REFERRAL_INVITER_BONUS_CREDITS })
      .eq("telegram_id", telegramId);
    if (upErr) {
      continue;
    }
    await supabase
      .from("referrals")
      .update({
        referrer_bonus_paid_at: now,
        status: "rewarded"
      })
      .eq("id", row.id);
    void logAnalyticsEvent(telegramId, "referral_reward_granted", {
      role: "referrer",
      credits: REFERRAL_INVITER_BONUS_CREDITS,
      invitee: row.invitee_telegram_id
    });
  }
}

export type ReferralClaimResult =
  | { ok: true; alreadyClaimed: boolean }
  | { ok: false; code: string; message: string };

export async function claimReferralLink(params: {
  inviteeTelegramId: number;
  referrerTelegramId: number;
  deviceFingerprint: string;
  ipHash: string | null;
}): Promise<ReferralClaimResult> {
  const { inviteeTelegramId, referrerTelegramId, deviceFingerprint, ipHash } = params;

  if (inviteeTelegramId === referrerTelegramId) {
    void logAnalyticsEvent(inviteeTelegramId, "referral_rejected", { reason: "self_referral" });
    return { ok: false, code: "self_referral", message: "Invalid invite." };
  }

  const fp = deviceFingerprint?.trim() || "";
  if (fp.length < 8) {
    void logAnalyticsEvent(inviteeTelegramId, "referral_rejected", { reason: "weak_fingerprint" });
    return { ok: false, code: "weak_fingerprint", message: "Could not verify device." };
  }

  const { data: existingInvitee } = await supabase.from("referrals").select("id").eq("invitee_telegram_id", inviteeTelegramId).maybeSingle();
  if (existingInvitee) {
    return { ok: true, alreadyClaimed: true };
  }

  const { data: dupDevice } = await supabase
    .from("referrals")
    .select("invitee_telegram_id")
    .eq("device_fingerprint", fp)
    .neq("invitee_telegram_id", inviteeTelegramId)
    .not("status", "eq", "rejected")
    .maybeSingle();

  if (dupDevice) {
    void logAnalyticsEvent(inviteeTelegramId, "referral_rejected", { reason: "device_reuse" });
    return { ok: false, code: "device_reuse", message: "This device already joined via another invite." };
  }

  const { data: inviteeUser } = await supabase
    .from("users")
    .select("referred_by_telegram_id")
    .eq("telegram_id", inviteeTelegramId)
    .maybeSingle();
  if (inviteeUser?.referred_by_telegram_id && Number(inviteeUser.referred_by_telegram_id) !== referrerTelegramId) {
    void logAnalyticsEvent(inviteeTelegramId, "referral_rejected", { reason: "already_referred" });
    return { ok: false, code: "already_referred", message: "Invite already linked to another creator." };
  }

  if (ipHash) {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await supabase
      .from("referrals")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .eq("legacy_row", false)
      .gte("created_at", hourAgo);
    if ((count ?? 0) >= 25) {
      void logAnalyticsEvent(inviteeTelegramId, "referral_flagged", { reason: "ip_velocity" });
      return { ok: false, code: "suspicious_ip", message: "Try again later." };
    }
  }

  const { error: insertError } = await supabase.from("referrals").insert([
    {
      referrer_telegram_id: referrerTelegramId,
      invitee_telegram_id: inviteeTelegramId,
      status: "pending" as ReferralStatus,
      device_fingerprint: fp,
      ip_hash: ipHash,
      legacy_row: false
    }
  ]);

  if (insertError) {
    if (insertError.code === "23505") {
      void logAnalyticsEvent(inviteeTelegramId, "referral_rejected", { reason: "duplicate_device_db" });
      return { ok: false, code: "device_reuse", message: "Invite already used on this device." };
    }
    return { ok: false, code: "insert_failed", message: insertError.message };
  }

  await supabase
    .from("users")
    .update({ referred_by_telegram_id: referrerTelegramId })
    .eq("telegram_id", inviteeTelegramId);

  void logAnalyticsEvent(inviteeTelegramId, "referral_signup", { referrer: referrerTelegramId });
  void logAnalyticsEvent(referrerTelegramId, "referral_link_created", { invitee: inviteeTelegramId });
  return { ok: true, alreadyClaimed: false };
}

export async function recordReferralFirstGeneration(inviteeTelegramId: number): Promise<void> {
  const { data: row } = await supabase
    .from("referrals")
    .select("*")
    .eq("invitee_telegram_id", inviteeTelegramId)
    .eq("legacy_row", false)
    .eq("status", "pending")
    .maybeSingle();

  if (!row || row.first_generation_at) {
    return;
  }

  const due = new Date(Date.now() + randomGrantDelayMs()).toISOString();
  await supabase
    .from("referrals")
    .update({
      first_generation_at: new Date().toISOString(),
      status: "activated",
      invitee_bonus_due_at: due
    })
    .eq("id", row.id);

  void logAnalyticsEvent(inviteeTelegramId, "referral_activation_completed", { referrer: row.referrer_telegram_id });
}

export async function recordReferralDownloadAck(inviteeTelegramId: number): Promise<void> {
  const { data: row } = await supabase
    .from("referrals")
    .select("*")
    .eq("invitee_telegram_id", inviteeTelegramId)
    .eq("legacy_row", false)
    .maybeSingle();

  if (!row || !row.first_generation_at || row.download_ack_at) {
    return;
  }

  const now = new Date().toISOString();
  const due = new Date(Date.now() + randomGrantDelayMs()).toISOString();

  const paidThisMonth = await countInviterPaidThisMonth(row.referrer_telegram_id);
  if (paidThisMonth >= REFERRAL_MONTHLY_REWARD_CAP) {
    await supabase
      .from("referrals")
      .update({
        download_ack_at: now,
        status: "flagged",
        fraud_flag: true,
        fraud_reason: "inviter_monthly_cap_at_download"
      })
      .eq("id", row.id);
    void logAnalyticsEvent(row.referrer_telegram_id, "referral_limit_reached", { at: "download_schedule" });
    return;
  }

  await supabase
    .from("referrals")
    .update({
      download_ack_at: now,
      referrer_bonus_due_at: due
    })
    .eq("id", row.id);

  void logAnalyticsEvent(inviteeTelegramId, "referral_download_ack", { referrer: row.referrer_telegram_id });
}

export type ReferralProfileSnapshot = {
  referralMonthlyCap: number;
  referralRewardsUsedThisMonth: number;
  referralSlotsRemaining: number;
  referralInviterBonusSecondsEarned: number;
  referralPendingCount: number;
  referralActivatedAwaitingPayout: number;
  referralAtMonthlyLimit: boolean;
};

export async function processReferralSideEffectsAfterGeneration(inviteeTelegramId: number): Promise<void> {
  await recordReferralFirstGeneration(inviteeTelegramId);
  await processDueReferralRewards(inviteeTelegramId);
  const { data: refRow } = await supabase
    .from("referrals")
    .select("referrer_telegram_id")
    .eq("invitee_telegram_id", inviteeTelegramId)
    .eq("legacy_row", false)
    .maybeSingle();
  if (refRow?.referrer_telegram_id) {
    await processDueReferralRewards(Number(refRow.referrer_telegram_id));
  }
}

export async function processReferralSideEffectsAfterDownload(inviteeTelegramId: number): Promise<void> {
  await recordReferralDownloadAck(inviteeTelegramId);
  await processDueReferralRewards(inviteeTelegramId);
  const { data: refRow } = await supabase
    .from("referrals")
    .select("referrer_telegram_id")
    .eq("invitee_telegram_id", inviteeTelegramId)
    .eq("legacy_row", false)
    .maybeSingle();
  if (refRow?.referrer_telegram_id) {
    await processDueReferralRewards(Number(refRow.referrer_telegram_id));
  }
}

export async function getReferralProfileSnapshot(telegramId: number): Promise<ReferralProfileSnapshot> {
  const start = monthStartIso();
  const { count: paidMonth } = await supabase
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_telegram_id", telegramId)
    .eq("legacy_row", false)
    .not("referrer_bonus_paid_at", "is", null)
    .gte("referrer_bonus_paid_at", start);

  const { data: rewarded } = await supabase
    .from("referrals")
    .select("id")
    .eq("referrer_telegram_id", telegramId)
    .not("referrer_bonus_paid_at", "is", null)
    .eq("legacy_row", false);

  const inviterSeconds = (rewarded?.length ?? 0) * REFERRAL_INVITER_BONUS_CREDITS;

  const { data: pending } = await supabase
    .from("referrals")
    .select("id, status, referrer_bonus_paid_at, invitee_bonus_paid_at, first_generation_at, download_ack_at")
    .eq("referrer_telegram_id", telegramId)
    .eq("legacy_row", false)
    .is("referrer_bonus_paid_at", null)
    .not("status", "eq", "rejected");

  const pendingCount = pending?.filter((p) => p.status === "pending").length ?? 0;
  const activatedAwaiting =
    pending?.filter(
      (p) =>
        p.first_generation_at &&
        p.download_ack_at &&
        !p.referrer_bonus_paid_at &&
        (p.status === "activated" || p.status === "pending")
    ).length ?? 0;

  const used = paidMonth ?? 0;
  const cap = REFERRAL_MONTHLY_REWARD_CAP;
  const remaining = Math.max(0, cap - used);

  return {
    referralMonthlyCap: cap,
    referralRewardsUsedThisMonth: used,
    referralSlotsRemaining: remaining,
    referralInviterBonusSecondsEarned: inviterSeconds,
    referralPendingCount: pendingCount,
    referralActivatedAwaitingPayout: activatedAwaiting,
    referralAtMonthlyLimit: remaining <= 0
  };
}
