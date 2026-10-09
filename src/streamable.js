const fs = require('fs');
const path = require('path');
const https = require('https');

// Free-plan limits. Clips over these are trimmed/compressed before upload.
const LIMIT_MB = 250;
const LIMIT_SECONDS = 600;

// Streams a file to Streamable's upload API as multipart/form-data so large
// clips never sit in memory, reporting byte progress as it goes.
function upload({ file, email, password, title }, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const boundary = '----ClipDeck' + Date.now().toString(16);
    const safeName = path.basename(file).replace(/[^\w.\- ()]/g, '_');
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: video/mp4\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const query = title ? `?title=${encodeURIComponent(title)}` : '';

    const req = https.request(
      {
        method: 'POST',
        host: 'api.streamable.com',
        path: '/upload' + query,
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64'),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': head.length + size + tail.length,
          'User-Agent': 'ClipDeck/0.1',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error('Streamable rejected the login. Check the email and password in Settings.'));
          }
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // handled below
          }
          if (res.statusCode >= 300 || !json || !json.shortcode) {
            return reject(new Error(`Streamable upload failed (${res.statusCode}): ${body.slice(0, 200)}`));
          }
          resolve({ shortcode: json.shortcode, url: `https://streamable.com/${json.shortcode}` });
        });
      }
    );
    req.on('error', reject);

    req.write(head);
    let sent = 0;
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => {
      sent += chunk.length;
      onProgress(sent / size);
      if (!req.write(chunk)) {
        stream.pause();
        req.once('drain', () => stream.resume());
      }
    });
    stream.on('error', (err) => req.destroy(err));
    stream.on('end', () => req.end(tail));
  });
}

module.exports = { upload, LIMIT_MB, LIMIT_SECONDS };
