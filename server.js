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

app.use(cors());
app.use(express.json({ limit: '500mb' }));

// Store uploads in temp directory
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join(os.tmpdir(), 'frameai');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_'));
  }
});

const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'FrameAI Server running', ffmpeg: ffmpegInstaller.path });
});

// Upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    success: true,
    filename: req.file.filename,
    path: req.file.path,
    size: req.file.size
  });
});

// Edit endpoint - merge videos, add audio, text overlay
app.post('/edit', async (req, res) => {
  const { clips, audioFilename, settings } = req.body;

  if (!clips || clips.length === 0) {
    return res.status(400).json({ error: 'No clips provided' });
  }

  const tmpDir = path.join(os.tmpdir(), 'frameai');
  const outputFilename = `output_${Date.now()}.mp4`;
  const outputPath = path.join(tmpDir, outputFilename);

  const speed = parseFloat(settings?.speed || 1.0);
  const textOverlay = settings?.textOverlay || '';
  const textPosition = settings?.textPosition || 'bottom';

  try {
    if (clips.length === 1) {
      // Single clip processing
      const inputPath = path.join(tmpDir, clips[0]);

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath);

        const filters = [];

        // Speed
        if (speed !== 1.0) {
          filters.push(`setpts=${(1/speed).toFixed(2)}*PTS`);
        }

        // Scale
        filters.push('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2');

        // Text overlay
        if (textOverlay) {
          const safeText = textOverlay.replace(/'/g, '').replace(/:/g, ' ');
          const yPos = textPosition === 'top' ? '50' : textPosition === 'center' ? '(h-text_h)/2' : 'h-th-60';
          filters.push(`drawtext=text='${safeText}':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=${yPos}:shadowcolor=black:shadowx=3:shadowy=3:box=1:boxcolor=black@0.4:boxborderw=10`);
        }

        cmd = cmd.videoFilters(filters);

        // Audio
        if (audioFilename) {
          const audioPath = path.join(tmpDir, audioFilename);
          if (fs.existsSync(audioPath)) {
            cmd = cmd.input(audioPath)
              .outputOptions(['-map 0:v:0', '-map 1:a:0', '-shortest']);
          }
        }

        cmd
          .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac', '-b:a 128k', '-movflags +faststart'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

    } else {
      // Multiple clips - re-encode each then concat
      const reEncodedPaths = [];

      for (let i = 0; i < clips.length; i++) {
        const inputPath = path.join(tmpDir, clips[i]);
        const reencPath = path.join(tmpDir, `reenc_${i}_${Date.now()}.mp4`);

        await new Promise((resolve, reject) => {
          let vf = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
          if (speed !== 1.0) {
            vf = `setpts=${(1/speed).toFixed(2)}*PTS,` + vf;
          }

          ffmpeg(inputPath)
            .videoFilters(vf)
            .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac', '-b:a 128k', '-r 30'])
            .output(reencPath)
            .on('end', () => { reEncodedPaths.push(reencPath); resolve(); })
            .on('error', reject)
            .run();
        });
      }

      // Create concat list
      const concatList = path.join(tmpDir, `concat_${Date.now()}.txt`);
      fs.writeFileSync(concatList, reEncodedPaths.map(p => `file '${p}'`).join('\n'));

      const concatOutput = path.join(tmpDir, `concat_out_${Date.now()}.mp4`);

      // Concat
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatList)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy'])
          .output(concatOutput)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Apply text overlay and audio to concat output
      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(concatOutput);
        const filters = [];

        if (textOverlay) {
          const safeText = textOverlay.replace(/'/g, '').replace(/:/g, ' ');
          const yPos = textPosition === 'top' ? '50' : textPosition === 'center' ? '(h-text_h)/2' : 'h-th-60';
          filters.push(`drawtext=text='${safeText}':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=${yPos}:shadowcolor=black:shadowx=3:shadowy=3:box=1:boxcolor=black@0.4:boxborderw=10`);
        }

        if (filters.length > 0) cmd = cmd.videoFilters(filters);

        if (audioFilename) {
          const audioPath = path.join(tmpDir, audioFilename);
          if (fs.existsSync(audioPath)) {
            cmd = cmd.input(audioPath)
              .outputOptions(['-map 0:v:0', '-map 1:a:0', '-shortest']);
          }
        }

        cmd
          .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac', '-b:a 128k', '-movflags +faststart'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Cleanup temp files
      reEncodedPaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
      try { fs.unlinkSync(concatList); fs.unlinkSync(concatOutput); } catch(e) {}
    }

    // Send the output file
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="frameai_output.mp4"`);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      try { fs.unlinkSync(outputPath); } catch(e) {}
    });

  } catch (err) {
    console.error('FFmpeg error:', err);
    res.status(500).json({ error: 'Video processing failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FrameAI Server running on port ${PORT}`);
});
