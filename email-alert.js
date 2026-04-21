/**
 * email-alert.js — Vistage Keyword Alert Emailer
 *
 * Sends an email to jperez@service-push.com whenever a scraped
 * thread/post contains ERP, CRM, or AI-related keywords.
 *
 * Config: alert-config.json  (SMTP credentials)
 */

import nodemailer from 'nodemailer';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dir, 'alert-config.json');

// ── Keyword groups ────────────────────────────────────────────────
export const ALERT_KEYWORDS = {
  CRM: [
    /\bcrm\b/i,
    /salesforce/i,
    /hubspot/i,
    /pipedrive/i,
    /zoho\b/i,
    /\bzoho crm\b/i,
    /customer relationship/i,
    /contact management/i,
    /\bsugarcrm\b/i,
    /monday.*crm/i,
    /\bclose\.io\b/i,
  ],
  ERP: [
    /\berp\b/i,
    /netsuite/i,
    /\bsap\b/i,
    /dynamics\s*(365|nav|ax|gp)/i,
    /\bepicor\b/i,
    /\bsage\s*\d*\b/i,
    /\bacumatica\b/i,
    /\bims\b.*erp/i,
    /enterprise resource/i,
    /\bjd edwards\b/i,
    /\bOracle erp\b/i,
    /\bworkday\b/i,
    /\bfinancials\b.*implement/i,
    /erp.*implement/i,
    /erp.*upgrade/i,
    /erp.*select/i,
  ],
  AI: [
    /\bai\b/i,
    /artificial intelligence/i,
    /chatgpt/i,
    /\bgpt[-\s]?\d/i,
    /\bcopilot\b/i,
    /\bllm\b/i,
    /machine learning/i,
    /\bml\b.*model/i,
    /\bautomation\b/i,
    /\bagentic\b/i,
    /\bai tool/i,
    /\bai agent/i,
    /\bai strateg/i,
    /\bai implement/i,
    /\bai help/i,
    /\bopenai\b/i,
    /\bclaude\b/i,
    /\bgemini\b.*ai/i,
    /digital transformation/i,
    /\bno.code\b/i,
    /\blow.code\b/i,
  ],
};

/**
 * Scan text for keyword matches. Returns { matched: bool, hits: {CRM:[...], ERP:[...], AI:[...]} }
 */
export const scanKeywords = (text = '') => {
  const hits = {};
  let matched = false;
  for (const [group, patterns] of Object.entries(ALERT_KEYWORDS)) {
    const found = patterns
      .filter(rx => rx.test(text))
      .map(rx => rx.source.replace(/\\b/g, '').replace(/\\/g, '').split('|')[0]);
    if (found.length) {
      hits[group] = [...new Set(found)];
      matched = true;
    }
  }
  return { matched, hits };
};

/**
 * Load SMTP config from alert-config.json
 */
const loadConfig = () => {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      `alert-config.json not found.\n` +
      `Create it with your SMTP credentials — see alert-config.example.json`
    );
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
};

/**
 * Send alert email for a list of keyword-matching posts.
 * @param {Array} alerts  — array of { person, hits, snippet }
 */
export const sendAlertEmail = async (alerts) => {
  if (!alerts || alerts.length === 0) return;

  const config = loadConfig();
  const transporter = nodemailer.createTransport({
    host:   config.smtp_host   || 'smtp.gmail.com',
    port:   config.smtp_port   || 587,
    secure: config.smtp_secure || false,
    auth: {
      user: config.smtp_user,
      pass: config.smtp_pass,
    },
  });

  // Group alerts by keyword group for clean display
  const crmAlerts = alerts.filter(a => a.hits.CRM);
  const erpAlerts = alerts.filter(a => a.hits.ERP);
  const aiAlerts  = alerts.filter(a => a.hits.AI);

  const fmt = (items) => items.map(a => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">
        <strong>${a.person.fullName}</strong><br>
        <span style="color:#555">${a.person.jobTitle || ''} @ ${a.person.company || ''}</span>
      </td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:#333;font-size:13px">
        ${a.snippet ? `"${a.snippet.substring(0, 200)}…"` : '(no snippet)'}
      </td>
      <td style="padding:8px;border-bottom:1px solid #eee">
        ${a.person.sourceThreadUrl
          ? `<a href="${a.person.sourceThreadUrl}" style="color:#1a73e8">View Thread</a>`
          : `<a href="${a.person.profileUrl || '#'}" style="color:#1a73e8">View Profile</a>`
        }
      </td>
    </tr>`).join('');

  const section = (title, color, items) => items.length === 0 ? '' : `
    <h3 style="color:${color};margin:24px 0 8px">${title} (${items.length})</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="padding:8px;text-align:left">Person</th>
          <th style="padding:8px;text-align:left">Post Snippet</th>
          <th style="padding:8px;text-align:left">Link</th>
        </tr>
      </thead>
      <tbody>${fmt(items)}</tbody>
    </table>`;

  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });

  const html = `
    <div style="font-family:sans-serif;max-width:800px;margin:0 auto">
      <div style="background:#1a73e8;color:white;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">🚨 Vistage Keyword Alert</h2>
        <p style="margin:4px 0 0;opacity:0.85">${alerts.length} match${alerts.length > 1 ? 'es' : ''} found — ${now} ET</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px">
        ${section('🔵 CRM Mentions', '#1a73e8', crmAlerts)}
        ${section('🟠 ERP Mentions', '#e65100', erpAlerts)}
        ${section('🟣 AI Help Mentions', '#6a1b9a', aiAlerts)}
        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
        <p style="color:#888;font-size:12px">
          Sent automatically by the Vistage Prospecting Scraper — CRM Experts Online<br>
          To change alert keywords, edit <code>email-alert.js</code>
        </p>
      </div>
    </div>`;

  await transporter.sendMail({
    from:    `"Vistage Alert" <${config.smtp_user}>`,
    to:      config.alert_to || 'jperez@service-push.com',
    subject: `🚨 Vistage Alert: ${[
      crmAlerts.length && `${crmAlerts.length} CRM`,
      erpAlerts.length && `${erpAlerts.length} ERP`,
      aiAlerts.length  && `${aiAlerts.length} AI`,
    ].filter(Boolean).join(', ')} mention${alerts.length > 1 ? 's' : ''} on MyVistage`,
    html,
  });

  console.log(`[email-alert] ✅ Alert sent → ${config.alert_to || 'jperez@service-push.com'} (${alerts.length} matches)`);
};
