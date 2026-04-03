import crypto from "crypto";

const SIGNATURE_VERSION = "v0";
const MAX_TIMESTAMP_AGE_SEC = 60 * 5;

/**
 * @param {string} signingSecret
 * @param {string} rawBody
 * @param {string | undefined} slackSignatureHeader
 * @param {string | undefined} slackRequestTimestampHeader
 * @returns {boolean}
 */
export function verifySlackRequest(
  signingSecret,
  rawBody,
  slackSignatureHeader,
  slackRequestTimestampHeader
) {
  if (!signingSecret || !rawBody || !slackSignatureHeader || !slackRequestTimestampHeader) {
    return false;
  }

  const ts = Number(slackRequestTimestampHeader);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_TIMESTAMP_AGE_SEC) return false;

  const sigBasestring = `${SIGNATURE_VERSION}:${slackRequestTimestampHeader}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret).update(sigBasestring).digest("hex");
  const expected = `${SIGNATURE_VERSION}=${hmac}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(slackSignatureHeader));
  } catch {
    return false;
  }
}
