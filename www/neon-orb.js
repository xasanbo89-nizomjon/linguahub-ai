// LinguaHub AI - Neon Electric Orb ("Dumoloq Neon Electro Signallar Bilan")
// High-tech, futuristic circular neon core with real-time procedural electric signals,
// crackling lightning arcs, pulsing shockwaves, and interactive electric surges.

(function () {
  "use strict";

  var instances = [];

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function createOrb(mountEl, options) {
    if (!mountEl) return null;
    var opts = options || {};
    var size = opts.size || 190;
    var interactive = opts.interactive !== false;

    mountEl.classList.add("neon-orb-container");
    mountEl.innerHTML = "";

    // Canvas element
    var canvas = document.createElement("canvas");
    canvas.className = "neon-electro-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Futuristic AI neon core with electric signals");
    mountEl.appendChild(canvas);

    // Decorative inner glow overlay (CSS layer for hardware-accelerated depth)
    var coreEl = document.createElement("div");
    coreEl.className = "neon-orb-core-glow";
    coreEl.setAttribute("aria-hidden", "true");
    mountEl.appendChild(coreEl);

    var ctx = canvas.getContext("2d");
    var dpr = typeof window !== "undefined" && window.devicePixelRatio ? Math.min(window.devicePixelRatio, 2) : 1;
    var width = size;
    var height = size;

    function resize() {
      dpr = typeof window !== "undefined" && window.devicePixelRatio ? Math.min(window.devicePixelRatio, 2) : 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
    }
    resize();

    var cx = width / 2;
    var cy = height / 2;
    var baseRadius = Math.round(size * 0.35);

    // Electric arcs state
    var arcs = [];
    var shockwaves = [];
    var sparks = [];
    var mouse = { x: -1000, y: -1000, active: false };
    var burstEnergy = 0;
    var rotation = 0;
    var isRunning = true;
    var animFrame = null;
    var lastTime = performance.now();

    // Shockwave class
    function triggerShockwave(intensity) {
      shockwaves.push({
        r: baseRadius * 0.85,
        maxR: baseRadius * 1.5,
        alpha: Math.min(1, intensity || 0.8),
        speed: rand(1.2, 1.8)
      });
    }

    // Spark particles
    function spawnSpark(x, y, vx, vy, color) {
      if (sparks.length > 40) sparks.shift();
      sparks.push({
        x: x,
        y: y,
        vx: vx || rand(-1.5, 1.5),
        vy: vy || rand(-1.5, 1.5),
        life: 1,
        decay: rand(0.02, 0.05),
        size: rand(1, 2.5),
        color: color || "#00f0ff"
      });
    }

    // Procedural Lightning Arc between two angles on the circle
    function generateArc(startAngle, endAngle, jitterAmount, steps) {
      var count = steps || Math.floor(rand(7, 13));
      var points = [];
      var deltaAngle = (endAngle - startAngle) / count;
      var curAngle = startAngle;

      for (var i = 0; i <= count; i++) {
        var progress = i / count;
        // Peak displacement in the middle of the arc
        var env = Math.sin(progress * Math.PI);
        var rOffset = rand(-jitterAmount, jitterAmount) * env;
        var r = baseRadius + rOffset;

        var px = cx + Math.cos(curAngle) * r;
        var py = cy + Math.sin(curAngle) * r;
        points.push({ x: px, y: py });
        curAngle += deltaAngle;
      }

      return {
        points: points,
        life: rand(3, 7), // frames to live
        width: rand(1, 2.2),
        color: Math.random() > 0.3 ? "#ffffff" : "#00f3ff",
        glow: Math.random() > 0.4 ? "#00f0ff" : "#9d4edd",
        branch: Math.random() > 0.6 ? generateBranch(points[Math.floor(count / 2)], curAngle) : null
      };
    }

    function generateBranch(origin, baseAngle) {
      var pts = [{ x: origin.x, y: origin.y }];
      var angle = baseAngle + rand(-0.7, 0.7);
      var length = rand(10, 22);
      var steps = 4;
      var curX = origin.x;
      var curY = origin.y;
      for (var i = 0; i < steps; i++) {
        curX += Math.cos(angle) * (length / steps) + rand(-3, 3);
        curY += Math.sin(angle) * (length / steps) + rand(-3, 3);
        pts.push({ x: curX, y: curY });
      }
      return pts;
    }

    // Cross-diameter lightning strike
    function generateCrossLightning() {
      var a1 = rand(0, Math.PI * 2);
      var a2 = a1 + Math.PI + rand(-0.4, 0.4);
      var x1 = cx + Math.cos(a1) * baseRadius;
      var y1 = cy + Math.sin(a1) * baseRadius;
      var x2 = cx + Math.cos(a2) * baseRadius;
      var y2 = cy + Math.sin(a2) * baseRadius;

      var steps = 10;
      var pts = [{ x: x1, y: y1 }];
      for (var i = 1; i < steps; i++) {
        var t = i / steps;
        var lx = x1 + (x2 - x1) * t + rand(-10, 10);
        var ly = y1 + (y2 - y1) * t + rand(-10, 10);
        pts.push({ x: lx, y: ly });
      }
      pts.push({ x: x2, y: y2 });

      return {
        points: pts,
        life: 4,
        width: rand(1.5, 2.5),
        color: "#ffffff",
        glow: "#00f0ff",
        branch: null
      };
    }

    // Periodic shockwave interval
    var shockwaveTimer = 0;

    function render(now) {
      if (!isRunning) return;
      var dt = (now - lastTime) / 1000;
      lastTime = now;
      if (dt > 0.1) dt = 0.1;

      shockwaveTimer += dt;
      if (shockwaveTimer > 2.2) {
        shockwaveTimer = 0;
        triggerShockwave(0.65);
      }

      if (burstEnergy > 0) {
        burstEnergy -= dt * 2.5;
        if (burstEnergy < 0) burstEnergy = 0;
      }

      rotation += (0.4 + burstEnergy * 1.5) * dt;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      // 1. Ambient pulsing outer energy aura
      var pulse = 0.5 + 0.5 * Math.sin(now * 0.003);
      var glowRadius = baseRadius * (1.35 + pulse * 0.12 + burstEnergy * 0.25);
      var radGrad = ctx.createRadialGradient(cx, cy, baseRadius * 0.3, cx, cy, glowRadius);
      radGrad.addColorStop(0, "rgba(0, 240, 255, " + (0.16 + burstEnergy * 0.2) + ")");
      radGrad.addColorStop(0.5, "rgba(120, 60, 255, " + (0.08 + pulse * 0.04) + ")");
      radGrad.addColorStop(0.85, "rgba(0, 200, 255, 0.03)");
      radGrad.addColorStop(1, "rgba(0, 0, 0, 0)");

      ctx.fillStyle = radGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
      ctx.fill();

      // 2. Shockwaves
      for (var s = shockwaves.length - 1; s >= 0; s--) {
        var sw = shockwaves[s];
        sw.r += sw.speed * (1 + burstEnergy);
        sw.alpha -= 0.015;
        if (sw.alpha <= 0 || sw.r >= sw.maxR) {
          shockwaves.splice(s, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(cx, cy, sw.r, 0, Math.PI * 2);
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = "rgba(0, 240, 255, " + sw.alpha * 0.7 + ")";
        ctx.shadowBlur = 10;
        ctx.shadowColor = "#00f0ff";
        ctx.stroke();
      }

      // 3. Central Dark Core with Inner Plasma Glow
      var coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius);
      coreGrad.addColorStop(0, "rgba(10, 25, 45, 0.95)");
      coreGrad.addColorStop(0.7, "rgba(5, 12, 28, 0.98)");
      coreGrad.addColorStop(0.96, "rgba(0, 240, 255, 0.35)");
      coreGrad.addColorStop(1, "rgba(0, 240, 255, 0.9)");

      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
      ctx.fillStyle = coreGrad;
      ctx.fill();

      // 4. Inner rotating energy rings
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);

      // Segmented outer ring dashes
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius + 3, 0, Math.PI * 2);
      ctx.setLineDash([14, 8, 4, 8]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0, 240, 255, 0.65)";
      ctx.shadowBlur = 8;
      ctx.shadowColor = "#00f0ff";
      ctx.stroke();

      // Counter-rotating inner energy circle
      ctx.rotate(-rotation * 2.2);
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius * 0.72, 0, Math.PI * 2);
      ctx.setLineDash([8, 12]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(168, 85, 247, 0.55)";
      ctx.shadowBlur = 6;
      ctx.shadowColor = "#a855f7";
      ctx.stroke();
      ctx.restore();

      // 5. Main Neon Glowing Ring (Double pass for intense bloom)
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = "#00f0ff";
      ctx.shadowBlur = 18 + burstEnergy * 15;
      ctx.shadowColor = "#00f0ff";
      ctx.stroke();

      // Secondary bright neon stroke
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#ffffff";
      ctx.shadowBlur = 5;
      ctx.shadowColor = "#ffffff";
      ctx.stroke();

      // 6. Generate & Render Electric Signals (Lightning Arcs)
      // High-frequency electric generation:
      var arcChance = 0.55 + burstEnergy * 0.35;
      if (Math.random() < arcChance) {
        var startA = rand(0, Math.PI * 2);
        var spanA = rand(0.4, 1.8);
        var jitter = rand(5, 14 + burstEnergy * 10);
        arcs.push(generateArc(startA, startA + spanA, jitter));
      }

      // Random cross-circle discharge
      if (Math.random() < 0.12 + burstEnergy * 0.3) {
        arcs.push(generateCrossLightning());
      }

      // If mouse is active and close, reach lightning to cursor
      if (mouse.active) {
        var dx = mouse.x - cx;
        var dy = mouse.y - cy;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > baseRadius * 0.5 && dist < baseRadius * 2.2) {
          var targetAngle = Math.atan2(dy, dx);
          var sx = cx + Math.cos(targetAngle) * baseRadius;
          var sy = cy + Math.sin(targetAngle) * baseRadius;
          var pts = [{ x: sx, y: sy }];
          var sSteps = 6;
          for (var p = 1; p < sSteps; p++) {
            var st = p / sSteps;
            pts.push({
              x: sx + (mouse.x - sx) * st + rand(-6, 6),
              y: sy + (mouse.y - sy) * st + rand(-6, 6)
            });
          }
          pts.push({ x: mouse.x, y: mouse.y });
          arcs.push({
            points: pts,
            life: 2,
            width: 1.8,
            color: "#ffffff",
            glow: "#00f0ff",
            branch: null
          });
        }
      }

      // Draw all current electric arcs
      for (var a = arcs.length - 1; a >= 0; a--) {
        var arc = arcs[a];
        arc.life--;
        if (arc.life <= 0) {
          arcs.splice(a, 1);
          continue;
        }

        ctx.beginPath();
        for (var i = 0; i < arc.points.length; i++) {
          var pt = arc.points[i];
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }
        ctx.lineWidth = arc.width;
        ctx.strokeStyle = arc.color;
        ctx.shadowBlur = 12;
        ctx.shadowColor = arc.glow;
        ctx.stroke();

        // Sub-branch
        if (arc.branch && arc.branch.length > 1) {
          ctx.beginPath();
          for (var b = 0; b < arc.branch.length; b++) {
            var bpt = arc.branch[b];
            if (b === 0) ctx.moveTo(bpt.x, bpt.y);
            else ctx.lineTo(bpt.x, bpt.y);
          }
          ctx.lineWidth = Math.max(0.8, arc.width * 0.6);
          ctx.strokeStyle = "rgba(0, 240, 255, 0.75)";
          ctx.shadowBlur = 7;
          ctx.shadowColor = "#00f0ff";
          ctx.stroke();
        }

        // Spawn a spark from arc endpoint
        if (Math.random() < 0.25) {
          var endPt = arc.points[arc.points.length - 1];
          spawnSpark(endPt.x, endPt.y, rand(-1.2, 1.2), rand(-1.2, 1.2), arc.glow);
        }
      }

      // 7. Spark Particles
      for (var sp = sparks.length - 1; sp >= 0; sp--) {
        var spark = sparks[sp];
        spark.x += spark.vx;
        spark.y += spark.vy;
        spark.life -= spark.decay;
        if (spark.life <= 0) {
          sparks.splice(sp, 1);
          continue;
        }

        ctx.beginPath();
        ctx.arc(spark.x, spark.y, spark.size * spark.life, 0, Math.PI * 2);
        ctx.fillStyle = spark.color;
        ctx.shadowBlur = 6;
        ctx.shadowColor = spark.color;
        ctx.fill();
      }

      // 8. Pulsing Central Nucleus
      var coreSize = 5 + Math.sin(now * 0.008) * 1.8 + burstEnergy * 4;
      var coreHalo = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreSize * 3);
      coreHalo.addColorStop(0, "#ffffff");
      coreHalo.addColorStop(0.3, "rgba(0, 240, 255, 0.95)");
      coreHalo.addColorStop(0.7, "rgba(147, 51, 234, 0.6)");
      coreHalo.addColorStop(1, "rgba(0, 0, 0, 0)");

      ctx.beginPath();
      ctx.arc(cx, cy, coreSize * 3, 0, Math.PI * 2);
      ctx.fillStyle = coreHalo;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, coreSize, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.shadowBlur = 14;
      ctx.shadowColor = "#00f0ff";
      ctx.fill();

      ctx.restore();

      animFrame = requestAnimationFrame(render);
    }

    // Interactivity
    function getCanvasCoords(e) {
      var rect = canvas.getBoundingClientRect();
      var clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      var clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      return {
        x: clientX - rect.left,
        y: clientY - rect.top
      };
    }

    if (interactive) {
      canvas.addEventListener("mousemove", function (e) {
        var pos = getCanvasCoords(e);
        mouse.x = pos.x;
        mouse.y = pos.y;
        mouse.active = true;
      });

      canvas.addEventListener("mouseleave", function () {
        mouse.active = false;
      });

      canvas.addEventListener("click", function (e) {
        burstEnergy = 1;
        triggerShockwave(1);
        for (var i = 0; i < 8; i++) {
          var a = (i / 8) * Math.PI * 2;
          arcs.push(generateArc(a, a + 0.8, 18, 12));
          var spX = cx + Math.cos(a) * baseRadius;
          var spY = cy + Math.sin(a) * baseRadius;
          spawnSpark(spX, spY, Math.cos(a) * rand(2, 4), Math.sin(a) * rand(2, 4), "#ffffff");
        }
      });

      canvas.addEventListener("touchstart", function (e) {
        var pos = getCanvasCoords(e);
        mouse.x = pos.x;
        mouse.y = pos.y;
        mouse.active = true;
        burstEnergy = 0.9;
        triggerShockwave(0.9);
      }, { passive: true });

      canvas.addEventListener("touchend", function () {
        mouse.active = false;
      });
    }

    // Page visibility pause
    function onVisibility() {
      if (document.hidden) {
        isRunning = false;
        if (animFrame) cancelAnimationFrame(animFrame);
      } else {
        if (!isRunning) {
          isRunning = true;
          lastTime = performance.now();
          animFrame = requestAnimationFrame(render);
        }
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    // Initial shockwave
    triggerShockwave(0.8);
    animFrame = requestAnimationFrame(render);

    var instance = {
      destroy: function () {
        isRunning = false;
        if (animFrame) cancelAnimationFrame(animFrame);
        document.removeEventListener("visibilitychange", onVisibility);
        mountEl.innerHTML = "";
      },
      triggerBurst: function () {
        burstEnergy = 1;
        triggerShockwave(1);
      }
    };

    instances.push(instance);
    return instance;
  }

  // Auto-mount on elements with [data-neon-orb] or .neon-orb-mount
  function initAutoMount() {
    var targets = document.querySelectorAll("[data-neon-orb], .neon-orb-mount");
    targets.forEach(function (el) {
      if (!el._hasNeonOrb) {
        el._hasNeonOrb = true;
        createOrb(el, {
          size: Number(el.getAttribute("data-orb-size")) || 190
        });
      }
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initAutoMount);
    } else {
      initAutoMount();
    }
  }

  window.LinguaHubNeonOrb = {
    create: createOrb,
    initAutoMount: initAutoMount
  };
})();
