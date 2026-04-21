/**
 * auth.js — One-time Google OAuth2 setup for Vistage Scraper
 *
 * Run this ONCE: node auth.js
 * It will open your browser, ask you to sign in with Google,
 * and save a refresh token to token.json for headless use.
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import http from 'http';
import open from 'open';

const CREDENTIALS_FILE = 'credentials.json';
const TOKEN_FILE = 'token.json';
const REDIRECT_PORT = 3333;
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

if (!existsSync(CREDENTIALS_FILE)) {
  console.error('❌ credentials.json not found.');
  console.error('');
  console.error('Please follow these steps:');
  console.error('  1. Go to https://console.cloud.google.com/');
  console.error('  2. Create project "vistage-scraper"');
  console.error('  3. Enable Google Sheets API');
  console.error('  4. Create OAuth2 credentials (Desktop app type)');
  console.error('  5. Download JSON and save as credentials.json in this directory');
  process.exit(1);
}

const creds = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
const { client_id, client_secret } = creds.installed || creds.web;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  `http://localhost:${REDIRECT_PORT}`
);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force refresh token even if previously authorized
});

console.log('🔐 Opening browser for Google authorization...');
console.log('   If it does not open automatically, visit:');
console.log('   ' + authUrl);
console.log('');

open(authUrl);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
    const code = url.searchParams.get('code');

    if (!code) {
      res.writeHead(400);
      res.end('No authorization code found. Please try again.');
      return;
    }

    const { tokens } = await oAuth2Client.getToken(code);
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>✅ Authorization complete!</h2>
        <p>token.json has been saved. You can close this tab.</p>
        <p>The Vistage scraper will now run headlessly without any browser interaction.</p>
      </body></html>
    `);

    console.log('✅ token.json saved successfully.');
    console.log('   The scraper will now run fully headless.');
    console.log('');
    console.log('Next step: node scraper.js');

    server.close();
  } catch (err) {
    console.error('❌ Error getting tokens:', err.message);
    res.writeHead(500);
    res.end('Error: ' + err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, () => {
  console.log(`   Waiting for Google to redirect to http://localhost:${REDIRECT_PORT} ...`);
});

server.on('error', (err) => {
  console.error(`❌ Could not start local server on port ${REDIRECT_PORT}:`, err.message);
  console.error('   Make sure no other process is using that port, then try again.');
  process.exit(1);
});
