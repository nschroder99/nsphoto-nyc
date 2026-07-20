/* ============================================================
   NS Photography — WebGL photography layer + interactions.
   Native scroll drives everything; each [data-gl] figure is
   mirrored by a static textured plane with a gentle fade-in
   reveal and shader grain. The twilight view crossfades
   day-to-night while pinned (uMix); the horizontal slider is
   JS-smoothed to avoid stepped scroll-driven motion.
   Fallback: without WebGL2 the plain <img> elements remain.
   ============================================================ */

(() => {
  "use strict";

  const docEl = document.documentElement;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(pointer: fine)").matches;
  // On touch devices the page scrolls on the compositor thread while the
  // GL canvas redraws a frame behind — photos visibly jitter. So phones
  // get plain DOM images (perfectly static) and the CSS twilight fallback.
  const useGL = !reduceMotion && finePointer;

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const cubicOut = (t) => 1 - Math.pow(1 - t, 3);

  /* ---------- plane registry ---------- */

  const figures = [...document.querySelectorAll("[data-gl]")];
  const planes = figures.map((el) => ({
    el,
    img: el.querySelector("img"),
    nightImg: el.querySelector(".night-img"),
    isHero: el.hasAttribute("data-hero"),
    isScrub: el.hasAttribute("data-scrub"),
    bitmap: null,
    nightBitmap: null,
    tex: null,
    tex2: null,
    tw: 1,
    th: 1,
    hover: 0,
    hoverT: 0,
    reveal: 0,
    revealing: false,
    rect: null,
  }));

  /* ---------- preloader ---------- */

  const countEl = document.getElementById("load-count");
  let loaded = 0;
  let shownProgress = 0;
  let loadingDone = false;
  const startTime = performance.now();

  const loadImage = (src, assign) => {
    const im = new Image();
    im.src = src;
    const settle = () => {
      assign(im);
      loaded++;
    };
    return (im.decode ? im.decode() : Promise.resolve()).then(settle, settle);
  };

  const loads = [];
  planes.forEach((p) => {
    loads.push(loadImage(p.img.getAttribute("src"), (im) => (p.bitmap = im)));
    if (p.nightImg) {
      loads.push(loadImage(p.nightImg.getAttribute("src"), (im) => (p.nightBitmap = im)));
    }
  });
  const totalLoads = loads.length;

  function tickCounter() {
    const target = (loaded / totalLoads) * 100;
    shownProgress = lerp(shownProgress, target, 0.14);
    if (countEl) {
      countEl.textContent = String(Math.round(shownProgress)).padStart(3, "0");
    }
    if (!loadingDone) requestAnimationFrame(tickCounter);
  }
  requestAnimationFrame(tickCounter);

  Promise.all(loads).then(() => {
    const elapsed = performance.now() - startTime;
    const wait = Math.max(0, 750 - elapsed);
    setTimeout(() => {
      loadingDone = true;
      if (countEl) countEl.textContent = "100";
      if (useGL) initGL();
      docEl.classList.add("is-loaded");
      startLoop();
    }, wait);
  });

  /* ---------- WebGL ---------- */

  const VERT = `#version 300 es
  layout(location = 0) in vec2 aPos;
  uniform vec2 uRes, uCenter, uSize;
  uniform float uVel;
  out vec2 vUv;
  void main() {
    vUv = aPos;
    vec2 pos = uCenter + (aPos - 0.5) * uSize;
    pos.y += sin(aPos.x * 3.141593) * uVel;
    pos.x += sin(aPos.y * 3.141593) * uVel * 0.3;
    gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
  }`;

  const FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 oCol;
  uniform sampler2D uTex, uTex2;
  uniform vec2 uSize, uTexSize;
  uniform float uVelN, uHover, uTime, uParallax, uZoom, uReveal, uMix;
  void main() {
    // reveal: a plain gradual fade-in across the whole plane
    float alpha = uReveal;
    if (alpha <= 0.001) discard;
    vec2 uv = vUv;
    float zoom = uZoom + 0.06 * uHover + (1.0 - uReveal) * 0.04;
    uv = (uv - 0.5) / zoom + 0.5;
    uv.y += uParallax;
    float pr = uSize.x / uSize.y;
    float tr = uTexSize.x / uTexSize.y;
    vec2 s = pr > tr ? vec2(1.0, tr / pr) : vec2(pr / tr, 1.0);
    uv = (uv - 0.5) * s + 0.5;
    float shift = uVelN * 0.005 + uHover * 0.0018;
    vec3 col = vec3(
      texture(uTex, uv + vec2(0.0, shift)).r,
      texture(uTex, uv).g,
      texture(uTex, uv - vec2(0.0, shift)).b
    );
    if (uMix > 0.001) {
      vec3 col2 = vec3(
        texture(uTex2, uv + vec2(0.0, shift)).r,
        texture(uTex2, uv).g,
        texture(uTex2, uv - vec2(0.0, shift)).b
      );
      col = mix(col, col2, uMix);
    }
    float g = fract(sin(dot(gl_FragCoord.xy + vec2(mod(uTime * 60.0, 997.0)), vec2(12.9898, 78.233))) * 43758.5453);
    col += (g - 0.5) * 0.035;
    oCol = vec4(col, alpha);
  }`;

  let gl = null;
  let uni = null;
  let indexCount = 0;
  const SEG = 24;

  function compile(glc, type, src) {
    const sh = glc.createShader(type);
    glc.shaderSource(sh, src);
    glc.compileShader(sh);
    if (!glc.getShaderParameter(sh, glc.COMPILE_STATUS)) {
      console.error(glc.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  function initGL() {
    const canvas = document.getElementById("gl");
    const ctx = canvas.getContext("webgl2", {
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    if (!ctx) return;

    const vs = compile(ctx, ctx.VERTEX_SHADER, VERT);
    const fs = compile(ctx, ctx.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = ctx.createProgram();
    ctx.attachShader(prog, vs);
    ctx.attachShader(prog, fs);
    ctx.linkProgram(prog);
    if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) {
      console.error(ctx.getProgramInfoLog(prog));
      return;
    }
    ctx.useProgram(prog);

    // subdivided unit quad
    const verts = [];
    for (let y = 0; y <= SEG; y++) {
      for (let x = 0; x <= SEG; x++) {
        verts.push(x / SEG, y / SEG);
      }
    }
    const idx = [];
    for (let y = 0; y < SEG; y++) {
      for (let x = 0; x < SEG; x++) {
        const a = y * (SEG + 1) + x;
        const b = a + 1;
        const c = a + SEG + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    indexCount = idx.length;

    const vbo = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, vbo);
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array(verts), ctx.STATIC_DRAW);
    ctx.enableVertexAttribArray(0);
    ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0);

    const ibo = ctx.createBuffer();
    ctx.bindBuffer(ctx.ELEMENT_ARRAY_BUFFER, ibo);
    ctx.bufferData(ctx.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), ctx.STATIC_DRAW);

    uni = {};
    ["uRes", "uCenter", "uSize", "uVel", "uTex", "uTex2", "uTexSize", "uVelN",
     "uHover", "uTime", "uParallax", "uZoom", "uReveal", "uMix"].forEach((n) => {
      uni[n] = ctx.getUniformLocation(prog, n);
    });
    ctx.uniform1i(uni.uTex, 0);
    ctx.uniform1i(uni.uTex2, 1);

    const aniso = ctx.getExtension("EXT_texture_filter_anisotropic");

    const makeTexture = (bitmap) => {
      const tex = ctx.createTexture();
      ctx.bindTexture(ctx.TEXTURE_2D, tex);
      ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA8, ctx.RGBA, ctx.UNSIGNED_BYTE, bitmap);
      ctx.generateMipmap(ctx.TEXTURE_2D);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR_MIPMAP_LINEAR);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
      if (aniso) {
        ctx.texParameterf(ctx.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      }
      return tex;
    };

    planes.forEach((p) => {
      if (!p.bitmap || !p.bitmap.naturalWidth) return;
      p.tex = makeTexture(p.bitmap);
      p.tw = p.bitmap.naturalWidth;
      p.th = p.bitmap.naturalHeight;
      if (p.nightBitmap && p.nightBitmap.naturalWidth) {
        p.tex2 = makeTexture(p.nightBitmap);
      }
    });

    ctx.enable(ctx.BLEND);
    ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA);

    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      gl = null;
      docEl.classList.remove("gl-active");
    });

    gl = ctx;
    resizeGL();
    docEl.classList.add("gl-active");
  }

  let dpr = 1;
  function resizeGL() {
    if (!gl) return;
    dpr = clamp(devicePixelRatio || 1, 1, finePointer ? 2 : 1.75);
    const canvas = gl.canvas;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uni.uRes, canvas.width, canvas.height);
  }

  /* ---------- pointer tracking ---------- */

  window.addEventListener("pointermove", (e) => {
    cursorTX = e.clientX;
    cursorTY = e.clientY;
  }, { passive: true });

  /* ---------- custom cursor ---------- */

  const cursorEl = document.querySelector(".cursor");
  const dotEl = document.querySelector(".cursor__dot");
  const ringEl = document.querySelector(".cursor__ring");
  let cursorTX = innerWidth / 2, cursorTY = innerHeight / 2;
  let dotX = cursorTX, dotY = cursorTY, ringX = cursorTX, ringY = cursorTY;

  if (finePointer) {
    document.addEventListener("pointerover", (e) => {
      const hit = e.target.closest("[data-cursor-hover], a, button");
      cursorEl.classList.toggle("is-hover", !!hit);
    });
  }

  /* ---------- dark chapter toggle ---------- */

  const twilightEl = document.querySelector(".twilight");
  let twilightTop = Infinity;

  function measure() {
    if (twilightEl) {
      const r = twilightEl.getBoundingClientRect();
      twilightTop = r.top + scrollY;
    }
  }

  window.addEventListener("resize", () => {
    resizeGL();
    measure();
  });

  /* ---------- slider: smooth wheel + inertial drag (mouse-friendly) ---------- */

  const hsTrack = document.querySelector(".hscroll__track");
  if (hsTrack && finePointer) {
    const maxScroll = () => Math.max(0, hsTrack.scrollWidth - hsTrack.clientWidth);

    // one rAF loop eases the track toward a target position
    let targetX = hsTrack.scrollLeft;
    let raf = 0;
    const tick = () => {
      const cur = hsTrack.scrollLeft;
      const diff = targetX - cur;
      if (Math.abs(diff) < 0.4) {
        hsTrack.scrollLeft = targetX;
        raf = 0;
        return;
      }
      hsTrack.scrollLeft = cur + diff * 0.16;
      raf = requestAnimationFrame(tick);
    };
    const glideTo = (x) => {
      targetX = clamp(x, 0, maxScroll());
      if (!raf) raf = requestAnimationFrame(tick);
    };

    // vertical mouse wheel over the strip → horizontal glide;
    // passes through to the page once the strip hits either end
    hsTrack.addEventListener("wheel", (e) => {
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      // resync when idle so external changes (cue click) can't desync the bounds
      if (!raf) targetX = hsTrack.scrollLeft;
      const max = maxScroll();
      const EDGE = 2; // sub-pixel tolerance so the ends never trap the wheel
      const atStart = targetX <= EDGE && delta < 0;
      const atEnd = targetX >= max - EDGE && delta > 0;
      if (atStart || atEnd) return; // let the page scroll normally
      e.preventDefault();
      glideTo(targetX + delta);
    }, { passive: false });

    // drag with momentum: releasing a flick keeps gliding, then eases to rest
    let dragging = false, lastX = 0, lastT = 0, vel = 0, dragMoved = 0;
    hsTrack.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.pointerType !== "mouse") return;
      dragging = true;
      dragMoved = 0;
      vel = 0;
      lastX = e.clientX;
      lastT = e.timeStamp;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      targetX = hsTrack.scrollLeft;
      hsTrack.setPointerCapture(e.pointerId);
    });
    hsTrack.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dt = Math.max(1, e.timeStamp - lastT);
      dragMoved += Math.abs(dx);
      vel = dx / dt; // px per ms
      lastX = e.clientX;
      lastT = e.timeStamp;
      targetX = clamp(hsTrack.scrollLeft - dx, 0, maxScroll());
      hsTrack.scrollLeft = targetX;
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      // fling: convert release velocity into a glide distance
      glideTo(targetX - vel * 320);
    };
    hsTrack.addEventListener("pointerup", endDrag);
    hsTrack.addEventListener("pointercancel", endDrag);
    // a real drag should not also fire a click (e.g. on "Book a shoot")
    hsTrack.addEventListener("click", (e) => {
      if (dragMoved > 6) {
        e.preventDefault();
        e.stopPropagation();
        dragMoved = 0;
      }
    }, true);
  }

  /* ---------- slider cue: fades once the strip moves; clicking advances it ---------- */

  const hsSection = document.querySelector(".hscroll");
  const hsCue = document.querySelector(".hscroll__cue");
  if (hsTrack && hsSection) {
    hsTrack.addEventListener("scroll", () => {
      if (hsTrack.scrollLeft > 24) hsSection.classList.add("is-scrolled");
    }, { passive: true });

    if (hsCue) {
      hsCue.addEventListener("click", () => {
        const panel = hsTrack.querySelector(".panel");
        const gap = parseFloat(getComputedStyle(hsTrack).columnGap) || 0;
        const step = panel ? panel.offsetWidth + gap : hsTrack.clientWidth * 0.8;
        hsTrack.scrollBy({ left: step, behavior: "smooth" });
      });
    }
  }

  /* ---------- twilight: crossfade plays once on entry ---------- */

  let nightStart = 0;
  const duskFigure = document.querySelector(".frame--dusk");
  if (duskFigure && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      const en = entries[entries.length - 1];
      const on = duskFigure.classList.contains("night-on");
      if (!on && en.intersectionRatio >= 0.45) {
        duskFigure.classList.add("night-on");
        nightStart = performance.now();
      } else if (on && !en.isIntersecting) {
        // fully off-screen: snap back to day so it replays on return
        duskFigure.classList.add("night-reset");
        duskFigure.classList.remove("night-on");
        void duskFigure.offsetWidth; // flush so the snap isn't animated
        duskFigure.classList.remove("night-reset");
        nightStart = 0;
      }
    }, { threshold: [0, 0.45] });
    io.observe(duskFigure);
  } else if (duskFigure) {
    duskFigure.classList.add("night-on");
  }

  /* ---------- main loop ---------- */

  let started = false;

  function startLoop() {
    if (started) return;
    started = true;
    measure();
    requestAnimationFrame(frame);
  }

  function frame(now) {
    const t = now * 0.001;
    const ih = innerHeight;

    // dark chapter
    document.body.classList.toggle("is-dark", scrollY + ih * 0.6 > twilightTop);

    // cursor: dot and ring travel together, no visible lag
    if (finePointer) {
      dotX = cursorTX;
      dotY = cursorTY;
      ringX = lerp(ringX, cursorTX, 0.5);
      ringY = lerp(ringY, cursorTY, 0.5);
      dotEl.style.transform = `translate(${dotX}px, ${dotY}px)`;
      ringEl.style.transform = `translate(${ringX}px, ${ringY}px)`;
    }

    // draw planes
    if (gl) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uni.uTime, t);

      for (const p of planes) {
        if (!p.tex) continue;
        const r = p.el.getBoundingClientRect();
        p.rect = r;
        if (r.bottom < -80 || r.top > ih + 80 || r.width === 0) continue;

        // reveal
        if (!p.revealing && r.top < ih * 0.92 && r.bottom > 0) {
          p.revealing = true;
        }
        if (p.revealing && p.reveal < 1) {
          p.reveal = Math.min(1, p.reveal + 1 / 100);
        }
        if (p.reveal <= 0) continue;
        const eased = cubicOut(p.reveal);

        // photos sit fully static in their frames — no scroll physics,
        // no overscan: GL frames exactly match the DOM cover-crop.
        // The twilight crossfade plays on a timer once triggered
        // (0.4s hold on the day view, then 2.6s day -> night).
        const zoom = 1.0;
        let mix = 0;
        if (p.isScrub && p.tex2 && nightStart) {
          mix = clamp((now - nightStart - 200) / 3000, 0, 1);
          mix = mix * mix * (3 - 2 * mix); // smoothstep
        }

        gl.uniform2f(uni.uCenter, (r.left + r.width / 2) * dpr, (r.top + r.height / 2) * dpr);
        gl.uniform2f(uni.uSize, r.width * dpr, r.height * dpr);
        gl.uniform2f(uni.uTexSize, p.tw, p.th);
        gl.uniform1f(uni.uZoom, zoom);
        gl.uniform1f(uni.uReveal, eased);
        gl.uniform1f(uni.uMix, mix);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, p.tex);
        if (p.tex2) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, p.tex2);
          gl.activeTexture(gl.TEXTURE0);
        }
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
      }
    }

    requestAnimationFrame(frame);
  }

  // safety: if fonts/anything stalls the load promise, force-start after 6s
  setTimeout(() => {
    if (!started) {
      loadingDone = true;
      if (useGL && !gl) initGL();
      docEl.classList.add("is-loaded");
      startLoop();
    }
  }, 6000);
})();
