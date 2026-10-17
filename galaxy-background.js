// Static particle-field renderer. Kept separate from game state and round logic.
export function initGalaxyCanvas() {
  const canvas = document.querySelector(".galaxy-particles");
  if (!canvas) return;
  const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!context) return;

  const random = (() => {
    // A stable seed keeps the particle composition art-directed between visits.
    let seed = 0x67a11a;
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  })();
  const normal = () => {
    const u = Math.max(0.00001, random());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };

  // Fine, low-contrast dust carries the color directly; no blur, bloom, or hard nuclei.
  // Muted colors are deliberately restrained so the starfield and multiplier stay readable.
  const palette = [
    [112, 91, 174],  // shadow violet
    [139, 91, 166],  // muted plum
    [160, 83, 133],  // dusty rose
    [174, 61, 91],   // subdued crimson
    [160, 146, 199], // dim lilac
    [86, 76, 135]    // deep violet
  ];
  const fillStyles = palette.map(([r, g, b]) => Array.from(
    { length: 37 },
    (_, alpha) => `rgba(${r},${g},${b},${(alpha / 100).toFixed(2)})`
  ));
  let particles = [];
  let width = 0;
  let height = 0;
  let dpr = 1;

  function chooseColor(x, y) {
    // A low-frequency color drift mixes warm and cool tones across the full formation.
    // No single coordinate becomes a bright red island or a planet-like center.
    const wave = 0.5 + 0.5 * Math.sin((x / width) * Math.PI * 2.1 + Math.sin((y / height) * Math.PI * 1.6) * 0.8);
    const roll = random();
    if (roll < 0.10 + wave * 0.07) return 3;
    if (roll < 0.28 + wave * 0.07) return 2;
    if (roll < 0.52) return 1;
    if (roll < 0.80) return 0;
    if (roll < 0.94) return 5;
    return 4;
  }

  function sampleCloudX() {
    // Two wide, overlapping density regions make elongated clusters; their overlap keeps them connected.
    // There are no focal centers, rings, or bright spherical bodies.
    if (random() < 0.58) {
      const side = random() < 0.5 ? -1 : 1;
      let candidate;
      do {
        candidate = width * (0.5 + side * (0.235 + normal() * 0.13));
      } while (candidate < 0 || candidate > width);
      return candidate;
    }
    return random() * width;
  }

  function buildParticles() {
    particles = [];
    // A restrained field of fine dust; density makes cloud shapes, not bright particles or blur.
    const count = Math.max(1800, Math.min(3600, Math.round(width * height / 58)));
    const centerY = height * 0.49;

    for (let i = 0; i < count; i += 1) {
      const source = random();
      let x;
      let y;
      let kind;

      if (source < 0.38) {
        x = sampleCloudX();
        const nx = (x / width - 0.5) * 2;
        const irregularity = 0.012 * Math.sin(nx * 7.2 + random() * 0.5) + 0.009 * Math.sin(nx * 13.4 + random());
        // Main dust lane: broad and broken up, with no nucleus or closed orbit.
        const spine = centerY + height * (0.035 * Math.sin(nx * 2.7 + 0.5) + 0.025 * Math.sin(nx * 5.3 - 0.7));
        y = spine + normal() * height * (0.095 + irregularity);
        kind = "main-dust";
      } else if (source < 0.64) {
        x = sampleCloudX();
        const nx = (x / width - 0.5) * 2;
        const irregularity = 0.012 * Math.sin(nx * 7.2 + random() * 0.5) + 0.009 * Math.sin(nx * 13.4 + random());
        // Loose upper filament overlaps the main lane instead of reading as a separate body.
        const spine = height * (0.30 + 0.075 * nx + 0.032 * Math.sin(nx * 3.7 + 0.9));
        y = spine + normal() * height * (0.063 + irregularity * 0.6);
        kind = "upper-dust";
      } else if (source < 0.86) {
        x = sampleCloudX();
        const nx = (x / width - 0.5) * 2;
        const irregularity = 0.012 * Math.sin(nx * 7.2 + random() * 0.5) + 0.009 * Math.sin(nx * 13.4 + random());
        // A faint lower wisp gives the field depth but leaves open space between streams.
        const spine = height * (0.68 - 0.055 * nx + 0.035 * Math.sin(nx * 3.1 - 0.8));
        y = spine + normal() * height * (0.067 + irregularity * 0.6);
        kind = "lower-dust";
      } else {
        // Sparse background grains keep the dark space from feeling like a solid flat panel.
        x = random() * width;
        y = random() * height;
        kind = "background-dust";
      }

      if (y < -height * 0.12 || y > height * 1.12) continue;
      const color = chooseColor(x, y);
      const sparkle = random() < 0.004;
      const size = sparkle ? 0.9 + random() * 0.35 : 0.42 + Math.pow(random(), 1.65) * (kind === "background-dust" ? 0.85 : 1.5);
      let alpha;
      if (sparkle) alpha = 0.24 + random() * 0.08;
      else if (kind === "main-dust") alpha = 0.11 + Math.pow(random(), 1.8) * 0.25;
      else if (kind === "upper-dust" || kind === "lower-dust") alpha = 0.07 + Math.pow(random(), 1.9) * 0.16;
      else alpha = 0.025 + random() * 0.07;

      const phase = random() * Math.PI * 2;
      // Bake the tiny initial offset into the point; no phase or kind metadata is needed later.
      particles.push({
        x: x + Math.sin(phase) * 0.42,
        y: y + Math.cos(phase) * 0.48,
        size,
        alpha,
        color
      });
    }
  }

  function drawStaticField() {
    context.clearRect(0, 0, width, height);

    for (const particle of particles) {
      const { x, y } = particle;
      if (x < -5 || x > width + 5 || y < -5 || y > height + 5) continue;

      // Keep the readout area quieter without hiding the moving CSS star trails.
      const nx = (x - width * 0.5) / (width * 0.26);
      const ny = (y - height * 0.44) / (height * 0.30);
      const centerQuiet = 1 - 0.64 * Math.exp(-((nx * nx) + (ny * ny)) * 1.05);
      const alpha = Math.min(0.31, particle.alpha * centerQuiet);
      const alphaStep = Math.min(36, Math.max(0, Math.round(alpha * 100)));
      context.fillStyle = fillStyles[particle.color][alphaStep];
      context.fillRect(x, y, particle.size, particle.size);
    }
    // The canvas retains the painted pixels, so release the temporary particle objects.
    particles = [];
  }

  function resize() {
    // Read the untransformed parent box: the canvas itself has a subtle CSS drift animation.
    const rect = (canvas.parentElement || canvas).getBoundingClientRect();
    const nextWidth = Math.max(1, rect.width);
    const nextHeight = Math.max(1, rect.height);
    const nextDpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (Math.abs(nextWidth - width) < 1 && Math.abs(nextHeight - height) < 1 && nextDpr === dpr) return;
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildParticles();
    drawStaticField();
  }

  // Expensive particle placement and painting now happen only at startup or resize.
  // CSS handles the very slight motion; no per-frame particle loop competes with input events.
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  if (resizeObserver) resizeObserver.observe(canvas.parentElement);
  else window.addEventListener("resize", resize, { passive: true });
  resize();
}
