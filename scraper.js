/**
 * scraper.js — Headless Vistage Prospecting Scraper v2
 * CRM Experts Online — fully autonomous, no browser window, no clicks required
 *
 * NEW in v2:
 *  • Dynamic network discovery — finds ALL networks on myvistage.com, not just 9
 *  • Thread scraping — visits every network's activity feed, extracts everyone
 *    who posted or commented (with their post text used for scoring)
 *  • Discovered networks and threads persisted in state.json
 *
 * Prereqs: npm install && npx playwright install chromium && node auth.js
 * Usage:   node scraper.js
 */

import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scanKeywords, sendAlertEmail } from './email-alert.js';

chromium.use(StealthPlugin());

const __dir = dirname(fileURLToPath(import.meta.url));
const p = (f) => join(__dir, f);

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════
const EXECUTION_BUDGET_MS       = 60 * 60 * 1000;   // 60 minutes
const WARN_AT_MS                = 57 * 60 * 1000;   // 57 minutes → wind-down
const ACTIVE_HOURS_START        = 2;                 // 2 AM ET
const ACTIVE_HOURS_END          = 23;                // 11 PM ET
const QUOTA_PER_RUN             = 11;                // ⚠️ conservative — threads/comments only
const DAILY_PROFILE_QUOTA       = 22;                // 2 logins × 11 = 22 max/day
const NETWORK_REDISCOVER_EVERY  = 5;                 // re-crawl groups page every N runs
const ZERO_RUN_DEEP_SCAN_AFTER  = 3;                 // consecutive zero runs before 120-day deep scan
const ACPAGE_MAX_NORMAL         = 3;                 // paginated feed pages in normal mode (?acpage=1..3 ≈ 60 days)
const ACPAGE_MAX_DEEP           = 6;                 // paginated feed pages in deep scan (?acpage=1..6 ≈ 120+ days)
const THREAD_REFRESH_EVERY      = 10;                // re-check old threads every N runs for new commenters
const SHEET_ID                  = '1GuQN_MF7HnV96Sml7l7s8V_inVefTUMSYf3hif4inqs';
const SHEET_TAB                 = 'Prospects';
const STATE_FILE                = p('state.json');
const CREDENTIALS_FILE          = p('credentials.json');
const TOKEN_FILE                = p('token.json');
const BROWSER_STATE_FILE        = p('browser-state.json');

const VISTAGE_EMAIL    = process.env.VISTAGE_EMAIL;
const VISTAGE_PASSWORD = process.env.VISTAGE_PASSWORD;

// Fallback networks — activity/discussion feeds ONLY. No /members/ pages ever.
const FALLBACK_NETWORKS = [
  'https://myvistage.com/groups/?artificial-intelligence-network/',
  'https://myvistage.com/groups/?chief-executive-network/',
  'https://myvistage.com/groups/?entrepreneurs-and-small-business-network/',
  'https://myvistage.com/groups/?manufacturing-network/',
  'https://myvistage.com/groups/?financial-services-network/',
  'https://myvistage.com/groups/?marketing-and-media-network/',
  'https://myvistage.com/groups/?talent-strategies-network/',
  'https://myvistage.com/groups/?technology-innovation-network/',
  'https://myvistage.com/groups/?vistage-worldwide-members/',
  // NOTE: /members/ pages intentionally excluded — they trigger People Search limits
];

const SHEET_HEADERS = [
  'Date Discovered', 'Full Name', 'Title', 'Company', 'Email', 'Phone',
  'Profile URL', 'Group(s)', 'Industry', 'CRM Fit Score', 'ERP Fit Score',
  'AI Fit Score', 'Opportunity Tier', 'Relevant Topics', 'Summary of Discussions',
  'Buying Signals', 'Source Thread URL(s)', 'Last Checked', 'Status',
];

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
const RUN_START = Date.now();
let WINDING_DOWN = false;

const randomWait = (minMs, maxMs) =>
  new Promise(r => setTimeout(r, Math.floor(Math.random() * (maxMs - minMs)) + minMs));

const checkBudget = () => {
  const elapsed = Date.now() - RUN_START;
  if (elapsed >= EXECUTION_BUDGET_MS) throw new Error('BUDGET_EXCEEDED');
  if (elapsed >= WARN_AT_MS) WINDING_DOWN = true;
};

const budgetRemaining = () => Math.max(0, EXECUTION_BUDGET_MS - (Date.now() - RUN_START));

const getEasternHour = () =>
  parseInt(new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }), 10);

const nowISO   = () => new Date().toISOString();
const todayDate = () => new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

const networkNameFromUrl = (url) => {
  if (url.includes('/members/')) return 'Members Directory';
  const slug = url.split('/groups/?')[1]?.replace(/\/$/, '') || '';
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Unknown';
};

const cleanProfileUrl = (url) => {
  if (!url || !url.includes('/profile/?')) return url;
  const base = url.split('/profile/?')[0];
  const slug = (url.split('/profile/?')[1] || '').split('/')[0]; // strip /followers, /friends, etc.
  return `${base}/profile/?${slug}/`;
};

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let state;

const loadState = () => {
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = {};
  }
  state.processedProfileUrls     ||= [];
  state.processedThreadUrls      ||= [];
  state.processedNameCompanyKeys ||= [];
  state.discoveredNetworks       ||= [];
  state.networksDiscoveredAt     ||= null;
  state.pendingThreadUrls        ||= [];   // threads queued for profile extraction
  state.totalDiscoveredAllTime   ||= 0;
  state.runHistory               ||= [];
  state.consecutiveZeroRuns      ||= 0;
  state.deepScanMode             ||= false;
  state.dailyProfileCount        ||= 0;    // profiles scraped today
  state.dailyCountDate           ||= '';   // date string for daily reset
  state.version                  = '2.0';

  // Reset daily counter if it's a new day
  const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  if (state.dailyCountDate !== todayStr) {
    state.dailyProfileCount = 0;
    state.dailyCountDate    = todayStr;
    log(`New day (${todayStr}) — daily profile quota reset.`);
  }

  // Normalize all stored profile URLs (strip /followers, /friends, etc.)
  // This fixes legacy entries that were stored with suffixes
  state.processedProfileUrls = [...new Set(
    state.processedProfileUrls.map(u => cleanProfileUrl(u) || u)
  )];
};

const saveState = (extra = {}) => {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, ...extra }, null, 2));
    log('State saved.');
  } catch (err) {
    log('ERROR saving state:', err.message);
  }
};

// ═══════════════════════════════════════════════════════
// GOOGLE SHEETS CLIENT
// ═══════════════════════════════════════════════════════
const getSheetsClient = () => {
  if (!existsSync(TOKEN_FILE))       throw new Error('token.json not found — run: node auth.js');
  if (!existsSync(CREDENTIALS_FILE)) throw new Error('credentials.json not found');
  const creds  = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
  const tokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  const { client_id, client_secret } = creds.installed || creds.web;
  const auth = new google.auth.OAuth2(client_id, client_secret);
  auth.setCredentials(tokens);
  auth.on('tokens', (t) => writeFileSync(TOKEN_FILE, JSON.stringify({ ...tokens, ...t }, null, 2)));
  return google.sheets({ version: 'v4', auth });
};

const writeToSheet = async (prospects) => {
  if (prospects.length === 0) return;
  const sheets = getSheetsClient();
  const rows = prospects.map(p => [
    p.dateDiscovered, p.fullName, p.jobTitle, p.company,
    p.email, p.phone, p.profileUrl, p.groups, p.industry,
    p.crmScore, p.erpScore, p.aiScore, p.tier,
    p.relevantTopics, p.summary, p.buyingSignals,
    p.sourceThreadUrl || '', todayDate(), 'New',
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:S`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  log(`✅ Wrote ${rows.length} rows to Google Sheet.`);
};

const writeBackup = (prospects, suffix = '') => {
  const ts   = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const file = p(`backup_${ts}${suffix}.json`);
  writeFileSync(file, JSON.stringify(prospects, null, 2));
  log(`Backup saved to ${file}`);
};

// ═══════════════════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════════════════
const scoreProspect = (person) => {
  // Combine all text including thread post content for richer scoring
  const text = `${person.jobTitle} ${person.company} ${person.bio} ${person.groups} ${person.threadContent || ''}`.toLowerCase();
  const title = person.jobTitle.toLowerCase();

  let crm = 0;
  if (/\b(ceo|president|vp sales|sales director|cro|coo|founder|owner|managing director|md)\b/.test(title)) crm += 40;
  if (/\b(crm|salesforce|hubspot|zoho|pipedrive|pipeline|leads|sales process)\b/.test(text)) crm += 20;
  if (/\b(scaling|hiring reps|revenue growth|onboarding)\b/.test(text)) crm += 15;
  if (/\b(data silos|manual process|spreadsheets|scattered data)\b/.test(text)) crm += 10;
  if (/\bdirector\b/.test(title)) crm += 5;
  crm = Math.min(crm, 100);

  let erp = 0;
  if (/\b(erp|netsuite|sap|oracle|quickbooks enterprise|inventory|supply chain)\b/.test(text)) erp += 40;
  if (/\b(manufacturing|distribution|multi.location)\b/.test(text)) erp += 20;
  if (/\b(cost tracking|procurement|job costing|billing)\b/.test(text)) erp += 15;
  if (/\b(cfo|coo|vp operations|finance|operations)\b/.test(title)) erp += 10;
  erp = Math.min(erp, 100);

  let ai = 0;
  if (/\b(ai|artificial intelligence|automation|chatgpt|workflow automation|machine learning|ml)\b/.test(text)) ai += 40;
  if (/\b(growth|scale|expand|accelerate)\b/.test(text)) ai += 20;
  if (/\b(saving time|reducing headcount|productivity|efficiency)\b/.test(text)) ai += 15;
  if (/\b(data analysis|reporting|forecasting|business intelligence|bi)\b/.test(text)) ai += 10;
  ai = Math.min(ai, 100);

  // Bonus: thread participation signals active engagement
  if (person.threadContent) {
    if (/\b(recommend|suggest|looking for|need a tool|advice|anyone use)\b/.test(person.threadContent.toLowerCase())) {
      crm += 10; erp += 10; ai += 10;
    }
  }
  crm = Math.min(crm, 100);
  erp = Math.min(erp, 100);
  ai  = Math.min(ai,  100);

  let tier;
  if (crm >= 75 || erp >= 75 || ai >= 75 || (crm + erp + ai) >= 150) tier = 'High';
  else if (crm >= 50 || erp >= 50 || ai >= 50)                        tier = 'Medium';
  else                                                                  tier = 'Low';

  const signals = [];
  if (/\b(frustrated|unhappy|replacing|switching|looking for)\b/.test(text)) signals.push('Frustrated with current software/tools');
  if (/\b(pain|challenge|struggle|problem|issue)\b/.test(text))             signals.push('Operational pain points mentioned');
  if (/\b(growing|scaling|hiring|expanding)\b/.test(text))                  signals.push('Discussing growth/hiring/scaling');
  if (/\b(recommend|suggest|looking for|need a tool|advice)\b/.test(text))  signals.push('Asked for software/vendor recommendations');
  if (/\b(evaluating|rfp|selection|choosing|comparing)\b/.test(text))       signals.push('Upcoming evaluation or project mentioned');
  if (/\b(ceo|coo|cfo|president|founder|owner|vp|director)\b/.test(title))  signals.push('Decision-making role');
  if (person.sourceThreadUrl)                                                signals.push('Active thread participant');

  const topics = [];
  if (/\b(crm|sales|leads|pipeline)\b/.test(text))         topics.push('CRM/Sales');
  if (/\b(erp|netsuite|inventory|operations)\b/.test(text)) topics.push('ERP/Operations');
  if (/\b(ai|automation|chatgpt)\b/.test(text))             topics.push('AI/Automation');
  if (/\b(marketing|campaigns|social)\b/.test(text))        topics.push('Marketing');
  if (/\b(hiring|recruiting|talent|hr)\b/.test(text))       topics.push('HR/Recruiting');
  if (/\b(finance|accounting|billing|revenue)\b/.test(text)) topics.push('Finance');
  if (topics.length === 0) topics.push('Business Leadership');

  let industry = 'Other';
  if      (/\b(tech|software|saas|digital|it)\b/.test(text))                       industry = 'Technology';
  else if (/\b(manufacturing|industrial|production)\b/.test(text))                 industry = 'Manufacturing';
  else if (/\b(health|medical|pharma|dental|clinic)\b/.test(text))                 industry = 'Healthcare';
  else if (/\b(finance|bank|insurance|investment|wealth)\b/.test(text))            industry = 'Financial Services';
  else if (/\b(real estate|property|construction)\b/.test(text))                   industry = 'Real Estate';
  else if (/\b(retail|ecommerce|wholesale|distribution)\b/.test(text))             industry = 'Retail/Distribution';
  else if (/\b(consult|advisory|professional services)\b/.test(text))              industry = 'Professional Services';
  else if (/\b(market|advertis|pr|media|brand)\b/.test(text))                      industry = 'Marketing/Media';
  else if (/\b(recruit|staffing|talent|hr)\b/.test(text))                         industry = 'HR/Recruiting';
  else if (/\b(food|beverage|restaurant|hospitality)\b/.test(text))               industry = 'Food & Beverage';

  const summary = person.bio
    ? person.bio.substring(0, 200).replace(/\n/g, ' ')
    : `${person.fullName} is ${person.jobTitle} at ${person.company}.`;

  return { ...person, industry, crmScore: crm, erpScore: erp, aiScore: ai, tier,
           buyingSignals: signals.join('; '), relevantTopics: topics.join(', '), summary };
};

// ═══════════════════════════════════════════════════════
// PROFILE EXTRACTION
// ═══════════════════════════════════════════════════════
const extractProfile = async (page, url, networkName, sourceThreadUrl = '', threadContent = '') => {
  const cleanUrl = cleanProfileUrl(url);
  await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await randomWait(1500, 3500);

  const scrollPct = 0.4 + Math.random() * 0.5;
  await page.evaluate((pct) => window.scrollTo(0, document.body.scrollHeight * pct), scrollPct);
  await randomWait(700, 1600);

  const raw = await page.evaluate(() => {
    const txt   = document.body.innerText;
    const name  = document.title.replace(/\(\d+\)\s*/, '').trim().replace(' - MyVistage', '').trim();
    const lines = txt.split('\n').map(l => l.trim()).filter(l => l);
    const ni    = lines.findIndex(l => l === name);
    const tl    = ni >= 0 ? lines[ni + 1] || '' : '';
    const cl    = ni >= 0 ? lines[ni + 2] || '' : '';
    const email = (txt.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/) || [])[1] || '';
    const phone = (txt.match(/(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/) || [])[1] || '';
    const bm    = txt.match(/Biography:([\s\S]{0,500})/);
    const bio   = bm ? bm[1].trim().substring(0, 300) : '';
    const gm    = txt.match(/Groups\n([\s\S]{0,300}?)Networks/);
    const groups = gm ? gm[1].trim().split('\n').filter(l => l.trim().length > 2).join(', ') : '';
    return JSON.stringify({ name, tl, cl, email, phone, bio, groups, url: window.location.href });
  });

  const data = JSON.parse(raw);
  if (!data.name || data.name.length < 2)  return null;
  if (/vistagechair|vistage-com/i.test(url)) return null;

  return {
    fullName: data.name, jobTitle: data.tl, company: data.cl,
    email: data.email, phone: data.phone, bio: data.bio, groups: data.groups,
    profileUrl: cleanUrl, networkDiscoveredIn: networkName,
    dateDiscovered: todayDate(), sourceThreadUrl, threadContent,
  };
};

// ═══════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════
const login = async (page, context) => {
  await randomWait(2000, 5000);
  await page.goto('https://myvistage.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomWait(3000, 6000);

  const loggedIn = await page.$('a[href*="/groups/"], a[href*="/members/"]');
  if (loggedIn) { log('Already logged in.'); return true; }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await randomWait(1000, 3000);
      const emailField = await page.$('input[name="username"], input[type="email"], input[name="log"], input[name="email"], #user_login');
      if (!emailField) throw new Error('Email field not found');
      await emailField.click();
      await randomWait(500, 1200);
      await emailField.type(VISTAGE_EMAIL, { delay: 50 + Math.random() * 80 });

      await randomWait(800, 2000);
      const passField = await page.$('input[name="password"], input[type="password"], input[name="pwd"], #user_pass');
      if (!passField) throw new Error('Password field not found');
      await passField.click();
      await randomWait(500, 1000);
      await passField.type(VISTAGE_PASSWORD, { delay: 50 + Math.random() * 80 });

      await randomWait(1000, 2000);
      const submit = await page.$('button[type="submit"], input[type="submit"], .ps-btn, .login-submit, #wp-submit');
      if (submit) await submit.click();
      else        await page.keyboard.press('Enter');

      await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
      await randomWait(3000, 6000);

      const success = await page.$('a[href*="/groups/"], a[href*="/members/"]');
      if (success) {
        log(`Logged in on attempt ${attempt}.`);
        // Save browser state so next run reuses cookies (looks like returning user)
        await context.storageState({ path: BROWSER_STATE_FILE });
        log('Browser state saved.');
        return true;
      }
    } catch (err) {
      log(`Login attempt ${attempt} failed: ${err.message}`);
      if (attempt < 2) await randomWait(8000, 12000);
    }
  }
  log('Login failed after 2 attempts.');
  return false;
};

// ═══════════════════════════════════════════════════════
// CAPTCHA CHECK
// ═══════════════════════════════════════════════════════
const isCaptchaPage = async (page) => {
  const captcha = await page.$('iframe[src*="recaptcha"], .cf-challenge-running, #challenge-form');
  return !!captcha;
};

// ═══════════════════════════════════════════════════════
// DYNAMIC NETWORK DISCOVERY
// ═══════════════════════════════════════════════════════
const discoverAllNetworks = async (page) => {
  log('🔍 Discovering all networks dynamically...');
  const found = new Set();

  // Pages to crawl for network links
  const discoveryPages = [
    'https://myvistage.com/groups/',
    'https://myvistage.com/groups/my-groups/',
    'https://myvistage.com/groups/all-groups/',
  ];

  for (const url of discoveryPages) {
    checkBudget();
    if (WINDING_DOWN) break;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await randomWait(2000, 4000);

      // Scroll to load lazy content
      for (let s = 0; s < 4; s++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
        await randomWait(800, 1500);
      }

      const links = await page.evaluate(() => {
        const anchors = [...document.querySelectorAll('a[href*="/groups/?"]')];
        return anchors
          .map(a => a.href)
          .filter(h =>
            !/\/(members|activity|discuss|join|leave|send-invite|admin|create|manage|my-groups|all-groups)/.test(h) &&
            h.includes('/groups/?') &&
            h.split('/groups/?')[1]?.length > 2
          )
          .map(h => {
            // Normalize: keep only the base group URL
            const part = h.split('/groups/?')[1].split('/')[0];
            return `https://myvistage.com/groups/?${part}/`;
          });
      });

      links.forEach(l => found.add(l));
      log(`  ${url} → found ${links.length} network links`);
    } catch (err) {
      log(`  Discovery error on ${url}: ${err.message}`);
    }
    await randomWait(3000, 6000);
  }

  let networks = [...found];

  // ⚠️ DO NOT include /members/ directory — it counts against People Search limits
  // Profiles are discovered organically via network activity feeds and threads only.

  // Merge with known fallbacks in case discovery missed any
  FALLBACK_NETWORKS.forEach(f => { if (!networks.includes(f)) networks.push(f); });

  // De-dupe
  networks = [...new Set(networks)];

  log(`✅ Discovered ${networks.length} total networks (including fallbacks).`);
  return networks;
};

// ═══════════════════════════════════════════════════════
// THREAD ACTIVITY SCRAPING
// ═══════════════════════════════════════════════════════

/**
 * Extract all thread URLs + profile links from a single loaded page.
 * Shared by both the scroll-based and paginated feed scrapers.
 */
const extractFromFeedPage = async (page) => {
  // Scroll to trigger lazy-loaded items
  const scrollPasses = state.deepScanMode ? 8 : 4;
  for (let s = 0; s < scrollPasses; s++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await randomWait(500, 1000);
  }

  // Click "Load More" if present
  const loadMoreClicks = state.deepScanMode ? 5 : 2;
  for (let click = 0; click < loadMoreClicks; click++) {
    const loadMore = await page.$('a.load-more, button.load-more, .activity-load-more a, #activity-stream .load-more a');
    if (!loadMore) break;
    await loadMore.click().catch(() => {});
    await randomWait(1800, 3000);
  }

  return page.evaluate(() => {
    const threadLinks = new Set();
    const profileLinks = new Map();

    [...document.querySelectorAll('a[href*="/?status/"], a[href*="/activity/"], a[href*="/topic/"]')]
      .forEach(a => {
        if (a.href.includes('/?status/') || a.href.includes('/topic/')) threadLinks.add(a.href);
      });

    [...document.querySelectorAll('a[href*="/profile/?"]')].forEach(a => {
      if (/\/friends|\/calendar|\/notifications|\/about|jperez48|vistagechair|vistage-com/.test(a.href)) return;
      const item = a.closest('[class*="activity"], [class*="post"], [class*="item"], li, article');
      const content = item ? item.innerText.substring(0, 400) : '';
      if (!profileLinks.has(a.href)) profileLinks.set(a.href, content);
    });

    return {
      threadUrls: [...threadLinks],
      profiles: [...profileLinks.entries()].map(([url, content]) => ({ url, content })),
    };
  });
};

/**
 * Visit a network's activity feed and collect thread URLs + profile links.
 * Uses ?acpage=N pagination to reach historical content (60–120+ days back).
 * Returns { threadUrls: [...], profilesFromFeed: [{url, content}] }
 */
const scrapeNetworkActivity = async (page, networkUrl, networkName) => {
  const results = { threadUrls: [], profilesFromFeed: [] };
  if (networkUrl.includes('/members/')) return results;

  const acPageMax = state.deepScanMode ? ACPAGE_MAX_DEEP : ACPAGE_MAX_NORMAL;
  if (state.deepScanMode) log(`  [DEEP SCAN] Paginating up to ?acpage=${acPageMax} for ${networkName}`);

  // Try /activity/, /discuss/, /forum/ — stop at first that returns content
  const baseVariants = [
    networkUrl.replace(/\/$/, '') + '/activity/',
    networkUrl.replace(/\/$/, '') + '/discuss/',
    networkUrl.replace(/\/$/, '') + '/forum/',
  ];

  let workingBase = null;

  for (const variant of baseVariants) {
    checkBudget();
    if (WINDING_DOWN) break;
    try {
      await page.goto(variant, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await randomWait(2000, 4000);
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 200));
      if (/page not found|404|error/i.test(pageText)) continue;

      const extracted = await extractFromFeedPage(page);

      extracted.threadUrls.forEach(t => {
        if (!results.threadUrls.includes(t) && !state.processedThreadUrls.includes(t)) results.threadUrls.push(t);
      });
      extracted.profiles.forEach(({ url, content }) => {
        if (!results.profilesFromFeed.find(p => p.url === url)) results.profilesFromFeed.push({ url, content, networkName });
      });

      log(`  Feed page 1 (${variant}): +${extracted.threadUrls.length} threads, +${extracted.profiles.length} profiles`);

      if (extracted.threadUrls.length > 0 || extracted.profiles.length > 0) {
        workingBase = variant;
        break;
      }
    } catch (err) {
      log(`  Feed error ${variant}: ${err.message}`);
    }
    await randomWait(2000, 4000);
  }

  // ── Paginated historical pages (?acpage=2..N) ──────────────────────────
  // Each page goes roughly 2–4 weeks further back. acpage=6 ≈ 90–120 days.
  // We use direct URL navigation (not AJAX) — looks like normal browsing.
  if (workingBase && !WINDING_DOWN && budgetRemaining() > 5 * 60 * 1000) {
    for (let pg = 2; pg <= acPageMax; pg++) {
      checkBudget();
      if (WINDING_DOWN) break;

      // Build paginated URL — BuddyPress supports both query param and path forms
      const pageUrl = workingBase.includes('?')
        ? `${workingBase}&acpage=${pg}`
        : `${workingBase}?acpage=${pg}`;

      try {
        await randomWait(4000, 8000); // human-like pause between pages
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomWait(2000, 3500);

        const pageText = await page.evaluate(() => document.body.innerText.substring(0, 300));
        if (/page not found|404|no activity|nothing here/i.test(pageText)) {
          log(`  ?acpage=${pg}: no content, stopping pagination.`);
          break;
        }

        const extracted = await extractFromFeedPage(page);

        if (extracted.threadUrls.length === 0 && extracted.profiles.length === 0) {
          log(`  ?acpage=${pg}: empty — stopping pagination.`);
          break;
        }

        extracted.threadUrls.forEach(t => {
          if (!results.threadUrls.includes(t) && !state.processedThreadUrls.includes(t)) results.threadUrls.push(t);
        });
        extracted.profiles.forEach(({ url, content }) => {
          if (!results.profilesFromFeed.find(p => p.url === url)) results.profilesFromFeed.push({ url, content, networkName });
        });

        log(`  ?acpage=${pg}: +${extracted.threadUrls.length} threads, +${extracted.profiles.length} profiles`);

      } catch (err) {
        log(`  ?acpage=${pg} error: ${err.message}`);
        break;
      }
    }
  }

  return results;
};

/**
 * Visit a thread and extract all participant profile URLs + post text.
 */
const extractThreadParticipants = async (page, threadUrl, networkName) => {
  const participants = [];
  try {
    await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomWait(1500, 3000);

    // Scroll to load all comments
    for (let s = 0; s < 5; s++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await randomWait(500, 1000);
    }

    const extracted = await page.evaluate(() => {
      const results = new Map(); // profileUrl → post content
      const threadTitle = document.title.replace(' - MyVistage', '').trim();
      const allText = document.body.innerText;

      [...document.querySelectorAll('a[href*="/profile/?"]')].forEach(a => {
        if (/\/friends|\/calendar|\/notifications|\/about|jperez48|vistagechair|vistage-com/.test(a.href)) return;
        // Get the closest comment/post block for content
        const block = a.closest('[class*="comment"], [class*="reply"], [class*="post"], [class*="activity"], article, li');
        const content = block ? block.innerText.substring(0, 500) : '';
        if (!results.has(a.href)) {
          results.set(a.href, `[Thread: ${threadTitle}] ${content}`);
        }
      });

      return [...results.entries()].map(([url, content]) => ({ url, content }));
    });

    extracted.forEach(({ url, content }) => {
      participants.push({ url, content, networkName, sourceThreadUrl: threadUrl });
    });

    log(`  Thread ${threadUrl.split('/').slice(-2, -1)[0]}: ${participants.length} participants`);
  } catch (err) {
    log(`  Thread error ${threadUrl}: ${err.message}`);
  }
  return participants;
};

// ═══════════════════════════════════════════════════════
// PROFILE QUEUE PROCESSOR
// ═══════════════════════════════════════════════════════
const processProfileQueue = async (page, profileQueue, newPeopleThisRun, allDiscoveredPeople, networksVisited) => {
  // Build a fast-lookup Set of all already-processed clean URLs
  const processedSet = new Set(state.processedProfileUrls.map(u => cleanProfileUrl(u) || u));

  for (const { url, networkName, sourceThreadUrl, threadContent } of profileQueue) {
    checkBudget();
    if (WINDING_DOWN || newPeopleThisRun >= QUOTA_PER_RUN) break;
    if (state.dailyProfileCount >= DAILY_PROFILE_QUOTA) {
      log(`⚠️ Daily profile quota (${DAILY_PROFILE_QUOTA}) reached — stopping to avoid People Search limits.`);
      break;
    }

    const cleanUrl = cleanProfileUrl(url);
    if (processedSet.has(cleanUrl) || processedSet.has(url)) continue;

    // Longer, human-like delay between profile visits (30–90s)
    await randomWait(30000, 90000);

    try {
      log(`  Scraping: ${cleanUrl}`);
      const person = await extractProfile(page, cleanUrl, networkName, sourceThreadUrl, threadContent);

      if (!person) {
        state.processedProfileUrls.push(cleanUrl);
        processedSet.add(cleanUrl);
        continue;
      }

      const key = `${person.fullName.toLowerCase()}|${person.company.toLowerCase()}`;
      if (state.processedNameCompanyKeys.includes(key)) {
        state.processedProfileUrls.push(cleanUrl);
        processedSet.add(cleanUrl);
        log(`  Dupe: ${person.fullName}`);
        continue;
      }

      if (await isCaptchaPage(page)) {
        log('CAPTCHA detected mid-scrape. Saving state and exiting.');
        await saveState({ lastRunAt: nowISO() });
        return { stop: true };
      }

      const scored = scoreProspect(person);
      allDiscoveredPeople.push(scored);
      state.processedProfileUrls.push(cleanUrl);
      processedSet.add(cleanUrl);
      state.processedNameCompanyKeys.push(key);
      newPeopleThisRun++;
      state.dailyProfileCount++;

      // ── Keyword alert detection ──────────────────────────────────
      const scanText = [person.jobTitle, person.company, person.bio, person.threadContent].join(' ');
      const { matched, hits } = scanKeywords(scanText);
      if (matched) {
        const snippet = person.threadContent || person.bio || '';
        keywordAlerts.push({ person: scored, hits, snippet });
        const groups = Object.keys(hits).join(', ');
        log(`  🚨 KEYWORD MATCH [${groups}]: ${scored.fullName}`);
      }

      log(`  ✓ ${scored.fullName} | ${scored.company} | CRM:${scored.crmScore} ERP:${scored.erpScore} AI:${scored.aiScore} → ${scored.tier}${sourceThreadUrl ? ' [from thread]' : ''} [daily: ${state.dailyProfileCount}/${DAILY_PROFILE_QUOTA}]`);

      if (newPeopleThisRun % 5 === 0) {
        log(`  Pausing after ${newPeopleThisRun} profiles...`);
        await randomWait(20000, 40000);
      }
      if (newPeopleThisRun % 10 === 0) {
        log(`  Long pause after ${newPeopleThisRun} profiles...`);
        await randomWait(60000, 120000);
      }
    } catch (err) {
      if (err.message === 'BUDGET_EXCEEDED') throw err;
      log(`  Error on ${cleanUrl}: ${err.message}`);
      state.processedProfileUrls.push(cleanUrl);
    }
  }
  return { stop: false, newPeopleThisRun };
};

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
const main = async () => {
  // ── Step 1: Time check ───────────────────────────────
  const hour = getEasternHour();
  if (hour < ACTIVE_HOURS_START || hour >= ACTIVE_HOURS_END) {
    log(`Outside active window (${ACTIVE_HOURS_START}AM–${ACTIVE_HOURS_END}PM ET). ET hour: ${hour}. Stopping.`);
    process.exit(0);
  }

  // ── Step 2: Load state ───────────────────────────────
  loadState();
  log(`State loaded. Total discovered all-time: ${state.totalDiscoveredAllTime}`);

  // ── Step 3: Launch stealth browser ───────────────────
  const browser = await chromium.launch({
    channel: 'chrome',   // real Chrome — better TLS + fingerprint than bundled Chromium
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  // Reuse persistent browser state (cookies, localStorage) so the site
  // sees a returning user rather than a fresh anonymous session each run
  const hasSavedState = existsSync(BROWSER_STATE_FILE);
  const context = await browser.newContext({
    storageState: hasSavedState ? BROWSER_STATE_FILE : undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
  });
  if (hasSavedState) log('Loaded saved browser state (cookies/localStorage).');

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  // Patch navigator.webdriver to undefined at the page level (belt-and-suspenders)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  let newPeopleThisRun = 0;
  const allDiscoveredPeople = [];
  const keywordAlerts       = [];   // accumulates ERP/CRM/AI matches for end-of-run email
  const networksVisited     = [];

  try {
    // ── Step 4: Login ──────────────────────────────────
    checkBudget();
    const loggedIn = await login(page, context);
    if (!loggedIn) {
      log('Could not log in. Saving state and exiting.');
      saveState({ lastRunAt: nowISO() });
      await browser.close();
      process.exit(1);
    }
    checkBudget();

    // ── Step 5: Discover networks (dynamic) ───────────
    const runCount = state.runHistory.length;
    const needsRediscovery =
      state.discoveredNetworks.length === 0 ||
      runCount % NETWORK_REDISCOVER_EVERY === 0;

    if (needsRediscovery && !WINDING_DOWN) {
      log(`Refreshing network list (run #${runCount}, every ${NETWORK_REDISCOVER_EVERY} runs)...`);
      try {
        const fresh = await discoverAllNetworks(page);
        if (fresh.length > 0) {
          state.discoveredNetworks = fresh;
          state.networksDiscoveredAt = nowISO();
          log(`Network list updated: ${fresh.length} networks found.`);
        }
      } catch (err) {
        log(`Network discovery failed: ${err.message}. Using cached list.`);
      }
    }

    const networks = state.discoveredNetworks.length > 0
      ? state.discoveredNetworks
      : FALLBACK_NETWORKS;

    // Rotate starting point
    const startIdx = state.totalDiscoveredAllTime % networks.length;
    const orderedNetworks = [...networks.slice(startIdx), ...networks.slice(0, startIdx)];
    log(`Using ${networks.length} networks. Starting at index ${startIdx}.`);

    // ── Step 6: Scrape each network ────────────────────
    for (const networkUrl of orderedNetworks) {
      checkBudget();
      if (WINDING_DOWN || newPeopleThisRun >= QUOTA_PER_RUN) break;
      if (state.dailyProfileCount >= DAILY_PROFILE_QUOTA) {
        log(`⚠️ Daily quota (${DAILY_PROFILE_QUOTA}) reached — skipping remaining networks.`);
        break;
      }

      const networkName = networkNameFromUrl(networkUrl);
      log(`\n── Network: ${networkName} ──`);
      await randomWait(4000, 10000);

      // 6a: Load network main page
      try {
        await page.goto(networkUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      } catch {
        log(`Timeout loading ${networkUrl}, skipping.`);
        continue;
      }

      if (await isCaptchaPage(page)) {
        log('CAPTCHA detected. Saving state and exiting.');
        saveState({ lastRunAt: nowISO() });
        await browser.close();
        process.exit(0);
      }

      await randomWait(3000, 7000);
      for (let s = 0; s < 3; s++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.6));
        await randomWait(1000, 2500);
      }

      // 6b: Collect profile links from main network page
      const mainPageProfiles = await page.evaluate(() =>
        [...new Set(
          [...document.querySelectorAll('a[href*="/profile/?"]')]
            .map(a => a.href)
            .filter(h => !/jperez48|\/friends|\/calendar|\/notifications|\/about|vistagechair|vistage-com/.test(h))
        )]
      );

      // ⚠️ /members/ subpages intentionally disabled — they count against People Search limits.
      // Profiles are sourced from activity feeds and threads only.
      const memberSubProfiles = [];

      // 6d: Scrape activity feed for threads + direct profile mentions
      let activityProfiles = [];
      let newThreadUrls    = [];
      if (!networkUrl.includes('/members/') && !WINDING_DOWN && budgetRemaining() > 5 * 60 * 1000) {
        checkBudget();
        const activityData = await scrapeNetworkActivity(page, networkUrl, networkName);
        activityProfiles = activityData.profilesFromFeed;
        newThreadUrls    = activityData.threadUrls;

        // Queue new threads for processing (persist across runs)
        const unprocessedThreads = newThreadUrls.filter(t => !state.processedThreadUrls.includes(t));
        if (unprocessedThreads.length > 0) {
          // Add to persistent pending queue (cap at 200 to avoid bloat)
          const existing = new Set(state.pendingThreadUrls);
          unprocessedThreads.forEach(t => existing.add(t));
          state.pendingThreadUrls = [...existing].slice(-200);
          log(`  Queued ${unprocessedThreads.length} threads for future processing.`);
        }
      }

      // 6e: Process threads (from pending queue) to get more profiles
      let threadProfiles = [];
      if (!WINDING_DOWN && budgetRemaining() > 3 * 60 * 1000 && state.pendingThreadUrls.length > 0) {
        const threadsToProcess = state.pendingThreadUrls.splice(0, 5); // process 5 per network
        for (const threadUrl of threadsToProcess) {
          checkBudget();
          if (WINDING_DOWN) break;
          await randomWait(2000, 5000);
          const participants = await extractThreadParticipants(page, threadUrl, networkName);
          threadProfiles.push(...participants);
          state.processedThreadUrls.push(threadUrl);
        }
        if (threadProfiles.length > 0) log(`  ${threadProfiles.length} profiles from threads.`);
      }

      // 6f: Merge all profile sources (thread profiles get priority — richer data)
      const allProfileUrls = new Set([
        ...mainPageProfiles,
        ...memberSubProfiles,
        ...activityProfiles.map(p => p.url),
        ...threadProfiles.map(p => p.url),
      ]);

      const newProfileUrls = [...allProfileUrls].filter(
        u => !state.processedProfileUrls.includes(u) && !state.processedProfileUrls.includes(cleanProfileUrl(u))
      );
      log(`  Total: ${allProfileUrls.size} profiles found, ${newProfileUrls.length} new.`);

      if (newProfileUrls.length === 0) {
        log(`  All profiles already processed in ${networkName}. Moving on.`);
        continue;
      }

      networksVisited.push(networkName);

      // Build enriched queue (thread profiles first — they have post content)
      const profileQueue = newProfileUrls.map(url => {
        const fromThread   = threadProfiles.find(p => p.url === url || cleanProfileUrl(p.url) === cleanProfileUrl(url));
        const fromActivity = activityProfiles.find(p => p.url === url || cleanProfileUrl(p.url) === cleanProfileUrl(url));
        return {
          url,
          networkName,
          sourceThreadUrl: fromThread?.sourceThreadUrl || '',
          threadContent:   fromThread?.content || fromActivity?.content || '',
        };
      }).sort((a, b) => (b.threadContent ? 1 : 0) - (a.threadContent ? 1 : 0)); // thread-enriched first

      // Process profiles
      const result = await processProfileQueue(page, profileQueue, newPeopleThisRun, allDiscoveredPeople, networksVisited);
      if (result.stop) {
        await browser.close();
        saveState({ lastRunAt: nowISO() });
        process.exit(0);
      }
      newPeopleThisRun = result.newPeopleThisRun;
    }

  } catch (err) {
    if (err.message !== 'BUDGET_EXCEEDED') {
      log(`Unexpected error: ${err.message}`);
    } else {
      log('Budget exceeded — winding down.');
    }
  }

  // ── Step 7: Save browser state + close ───────────────
  try {
    await context.storageState({ path: BROWSER_STATE_FILE });
    log('Browser state saved for next run.');
  } catch { /* non-fatal */ }
  await browser.close().catch(() => {});

  // ── Step 8: Write to Google Sheet ────────────────────
  if (allDiscoveredPeople.length > 0) {
    log(`Writing ${allDiscoveredPeople.length} new prospects to Google Sheet...`);
    try {
      await writeToSheet(allDiscoveredPeople);
    } catch (err) {
      log(`Sheet write failed: ${err.message}. Saving backup.`);
      writeBackup(allDiscoveredPeople, '_failed');
    }
  } else {
    log('No new prospects this run.');
  }

  // ── Step 9: Send keyword alert email (if any matches) ──
  if (keywordAlerts.length > 0) {
    log(`Sending alert email for ${keywordAlerts.length} keyword match(es)...`);
    try {
      await sendAlertEmail(keywordAlerts);
    } catch (err) {
      log(`Alert email failed (non-fatal): ${err.message}`);
    }
  }

  // ── Step 10: Save state ────────────────────────────────
  state.totalDiscoveredAllTime += newPeopleThisRun;
  state.lastRunAt       = nowISO();
  state.lastRunNewCount = newPeopleThisRun;

  // Track consecutive zero-result runs → trigger deep scan after N misses
  if (newPeopleThisRun === 0) {
    state.consecutiveZeroRuns = (state.consecutiveZeroRuns || 0) + 1;
    if (state.consecutiveZeroRuns >= ZERO_RUN_DEEP_SCAN_AFTER) {
      state.deepScanMode = true;
      log(`⚠️  ${state.consecutiveZeroRuns} consecutive zero runs → activating DEEP SCAN (120-day lookback)`);
    }
  } else {
    state.consecutiveZeroRuns = 0;
    if (state.deepScanMode) {
      log('✅ Deep scan found new people — returning to normal mode.');
      state.deepScanMode = false;
    }
  }

  // ── Thread refresh: re-check old threads every N runs ──────────────────
  // Old threads accumulate new commenters over time. By clearing processedThreadUrls
  // periodically, we re-visit them and pick up anyone who replied since last visit.
  // We keep profile dedup intact so we never re-scrape people we already have.
  const runCount = state.runHistory.length;
  if (runCount > 0 && runCount % THREAD_REFRESH_EVERY === 0) {
    const oldCount = state.processedThreadUrls.length;
    state.processedThreadUrls = [];
    log(`♻️  Thread refresh (every ${THREAD_REFRESH_EVERY} runs): cleared ${oldCount} processed thread URLs — will re-check for new commenters next run.`);
  }

  state.runHistory.push({
    runAt: nowISO(), newCount: newPeopleThisRun, networksVisited,
    durationMs: Date.now() - RUN_START,
    networksAvailable: state.discoveredNetworks.length,
    deepScan: state.deepScanMode,
  });
  // Keep runHistory to last 100 entries
  if (state.runHistory.length > 100) state.runHistory = state.runHistory.slice(-100);
  saveState();

  // ── Step 10: Summary ───────────────────────────────────
  const durationMin  = ((Date.now() - RUN_START) / 60000).toFixed(1);
  const fromThreads  = allDiscoveredPeople.filter(p => p.sourceThreadUrl).length;
  const fromProfiles = allDiscoveredPeople.length - fromThreads;

  console.log('\n═══════════════════════════════════════════════');
  console.log(`Run complete       : ${new Date().toISOString()}`);
  console.log(`Duration           : ${durationMin} min / 60 min budget`);
  console.log(`New people         : ${newPeopleThisRun} / ${QUOTA_PER_RUN} quota`);
  console.log(`  → from profiles  : ${fromProfiles}`);
  console.log(`  → from threads   : ${fromThreads}`);
  console.log(`Total all-time     : ${state.totalDiscoveredAllTime}`);
  console.log(`Consec zero runs   : ${state.consecutiveZeroRuns} / ${ZERO_RUN_DEEP_SCAN_AFTER} (then deep scan)`);
  console.log(`Deep scan mode     : ${state.deepScanMode ? '🔍 ACTIVE (120-day lookback)' : 'off'}`);
  console.log(`Networks available : ${state.discoveredNetworks.length} (dynamic)`);
  console.log(`Networks visited   : ${networksVisited.join(', ') || 'none'}`);
  console.log(`Pending threads    : ${state.pendingThreadUrls.length}`);
  console.log(`Processed profiles : ${state.processedProfileUrls.length} (deduped)`);
  console.log(`Sheet              : https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
  console.log('═══════════════════════════════════════════════\n');
};

main().catch(err => {
  log('FATAL:', err.message);
  saveState({ lastRunAt: nowISO() });
  process.exit(1);
});
