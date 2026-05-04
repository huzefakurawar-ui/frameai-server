const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.options('*', cors());
app.use(express.json({ limit: '500mb' }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join(os.tmpdir(), 'frameai');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(file.originalname));
  }
});

const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.get('/', (req, res) => {
  res.json({ status: 'FrameAI Server running', ffmpeg: ffmpegInstaller.path });
});

// Edit endpoint - receives files directly
app.post('/edit', upload.fields([{ name: 'videos', maxCount: 20 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const videoFiles = req.files?.videos || [];
  const audioFiles = req.files?.audio || [];

  if (!videoFiles.length) {
    return res.status(400).json({ error: 'No video files provided' });
  }

  let settings = {};
  try { settings = JSON.parse(req.body.settings || '{}'); } catch(e) {}

  const tmpDir = path.join(os.tmpdir(), 'frameai');
  const outputPath = path.join(tmpDir, `output_${Date.now()}.mp4`);
  const speed = parseFloat(settings.speed || 1.0);
  const textOverlay = settings.textOverlay || '';
  const textPosition = settings.textPosition || 'bottom';
  const audioPath = audioFiles[0]?.path || null;

  const filesToClean = [...videoFiles.map(f => f.path), ...audioFiles.map(f => f.path), outputPath];

  try {
    if (videoFiles.length === 1) {
      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(videoFiles[0].path);
        const filters = [];
        if (speed !== 1.0) filters.push(`setpts=${(1/speed).toFixed(2)}*PTS`);
        filters.push('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2');
        if (textOverlay) {
          const safe = textOverlay.replace(/'/g, '').replace(/:/g, ' ');
          const y = textPosition==='top'?'50':textPosition==='center'?'(h-text_h)/2':'h-th-60';
          filters.push(`drawtext=text='${safe}':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=${y}:shadowcolor=black:shadowx=3:shadowy=3:box=1:boxcolor=black@0.4:boxborderw=10`);
        }
        cmd = cmd.videoFilters(filters);
        if (audioPath) cmd = cmd.input(audioPath).outputOptions(['-map 0:v:0', '-map 1:a:0', '-shortest']);
        cmd.outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac', '-b:a 128k', '-movflags +faststart'])
          .output(outputPath).on('end', resolve).on('error', reject).run();
      });

    } else {
      const reEncoded = [];
      for (let i = 0; i < videoFiles.length; i++) {
        const reencPath = path.join(tmpDir, `reenc_${i}_${Date.now()}.mp4`);
        filesToClean.push(reencPath);
        await new Promise((resolve, reject) => {
          let vf = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
          if (speed !== 1.0) vf = `setpts=${(1/speed).toFixed(2)}*PTS,` + vf;
          ffmpeg(videoFiles[i].path).videoFilters(vf)
            .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac', '-b:a 128k', '-r 30'])
            .output(reencPath).on('end', () => { reEncoded.push(reencPath); resolve(); }).on('error', reject).run();
        });
      }

      const concatList = path.join(tmpDir, `concat_${Date.now()}.txt`);
      const concatOut = path.join(tmpDir, `concatout_${Date.now()}.mp4`);
      filesToClean.push(concatList, concatOut);
      fs.writeFileSync(concatList, reEncoded.map(p => `file '${p}'`).join('\n'));

      await new Promise((resolve, reject) => {
        ffmpeg().input(concatList).inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy']).output(concatOut)
          .on('end', resolve).on('error', reject).run();
      });

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(concatOut);
        const filters = [];
        if (textOverlay) {
          const safe = textOverlay.replace(/'/g, '').replace(/:/g, ' ');
          const y = textPosition==='top'?'50':textPosition==='center'?'(h-text_h)/2':'h-th-60';
          filters.push(`drawtext=text='${safe}':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=${y}:shadowcolor=black:shadowx=3:shadowy=3:box=1:boxcolor=black@0.4:boxborderw=10`);
        }
        if (filters.length) cmd = cmd.videoFilters(filters);
        if (audioPath) cmd = cmd.input(audioPath).outputOptions(['-map 0:v:0', '-map 1:a:0', '-shortest']);
        cmd.outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac', '-b:a 128k', '-movflags +faststart'])
          .output(outputPath).on('end', resolve).on('error', reject).run();
      });

      reEncoded.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
      try { fs.unlinkSync(concatList); fs.unlinkSync(concatOut); } catch(e) {}
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="frameai_output.mp4"');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => { filesToClean.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} }); });

  } catch (err) {
    filesToClean.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    res.status(500).json({ error: 'Processing failed: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`FrameAI Server running on port ${PORT}`));
