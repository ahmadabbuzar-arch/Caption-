/* ============================================================
   Caption Studio — /api/transcribe
   Secure backend endpoint. Receives the extracted audio track,
   forwards it to Groq's Whisper API using a server-side-only
   API key, and returns timestamped caption segments.

   Required environment variable (set in your Vercel project,
   never committed to source control):
     GROQ_API_KEY = <your Groq API key>
   ============================================================ */

const formidableLib = require('formidable');
// formidable's export shape has changed across major versions (plain function
// in v2, a named `formidable` export or `.default` in v3 depending on how the
// CJS build is resolved) — detect whichever is actually callable so this
// keeps working regardless of which shape npm installed.
const formidableFactory =
  typeof formidableLib === 'function' ? formidableLib :
  typeof formidableLib.formidable === 'function' ? formidableLib.formidable :
  typeof formidableLib.default === 'function' ? formidableLib.default :
  null;
const fs = require('fs');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  if (!process.env.GROQ_API_KEY) {
    res.status(500).json({ error: 'Server is missing GROQ_API_KEY. Add it in your Vercel project settings under Environment Variables.' });
    return;
  }

  let audioPath, language;
  try {
    const parsed = await parseUpload(req);
    audioPath = parsed.path;
    language = parsed.fields.language || null;
  } catch (err) {
    res.status(400).json({ error: 'Could not read the uploaded audio: ' + err.message });
    return;
  }

  try {
    const stats = fs.statSync(audioPath);
    const MAX_BYTES = 25 * 1024 * 1024; // Groq's free-tier audio size ceiling
    if (stats.size > MAX_BYTES) {
      res.status(413).json({ error: 'Audio extracted from this video is too large to transcribe. Try a shorter clip.' });
      return;
    }

    const fileBuffer = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: 'audio/mp3' }), 'audio.mp3');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    // Ask for word-level timestamps in addition to segments. If the API
    // version in use doesn't support this, it's simply ignored server-side
    // and we fall back to evenly-estimated word timing (clearly flagged to
    // the user in the UI — never presented as if it were exact).
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');
    // Only forwarded for languages Whisper actually has a native mode for
    // (see engine.js LANGUAGES) — 'auto' and the two experimental options
    // send no language param and let the model auto-detect.
    if (language) form.append('language', language);

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form
    });

    const raw = await groqRes.text();
    let data;
    try { data = JSON.parse(raw); } catch (e) {
      res.status(502).json({ error: 'Groq returned an unexpected response.' });
      return;
    }

    if (!groqRes.ok) {
      const message = (data && data.error && data.error.message) || `Groq API error (status ${groqRes.status}).`;
      res.status(groqRes.status).json({ error: message });
      return;
    }

    // Group top-level word timestamps (when the API returned them) into
    // each segment by time range, so the client gets real word-level
    // start/end for karaoke-style highlighting instead of an estimate.
    const allWords = Array.isArray(data.words) ? data.words : null;

    const segments = (data.segments || []).map(s => {
      const text = (s.text || '').trim();
      let words = null;
      if (allWords) {
        words = allWords
          .filter(w => w.start >= s.start - 0.05 && w.start < s.end + 0.05)
          .map(w => ({ text: (w.word || '').trim(), start: w.start, end: w.end }))
          .filter(w => w.text.length > 0);
        if (!words.length) words = null;
      }
      return { start: s.start, end: s.end, text, words };
    }).filter(s => s.text.length > 0);

    res.status(200).json({ segments, language: data.language || null });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: 'Transcription failed. Please try again.' });
  } finally {
    if (audioPath) fs.unlink(audioPath, () => {});
  }
};

function parseUpload(req) {
  return new Promise((resolve, reject) => {
    let form;
    try {
      if (formidableFactory) {
        form = formidableFactory({ maxFileSize: 30 * 1024 * 1024 });
      } else if (formidableLib.IncomingForm) {
        // Older v1/v2-style constructor as a last-resort fallback
        form = new formidableLib.IncomingForm();
        form.maxFileSize = 30 * 1024 * 1024;
      } else {
        reject(new Error('the formidable package export shape was not recognized. Check the installed version.'));
        return;
      }
    } catch (err) {
      reject(err);
      return;
    }

    form.parse(req, (err, fields, files) => {
      if (err) { reject(err); return; }
      const file = files.audio && (Array.isArray(files.audio) ? files.audio[0] : files.audio);
      if (!file) { reject(new Error('no audio file was included in the request.')); return; }
      const languageField = fields.language && (Array.isArray(fields.language) ? fields.language[0] : fields.language);
      resolve({ path: file.filepath || file.path, fields: { language: languageField || null } });
    });
  });
}

module.exports.config = {
  api: {
    bodyParser: false
  }
};
