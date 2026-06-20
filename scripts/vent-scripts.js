(function(){
  "use strict";

  // ---------------- STATE ----------------
  let mode = "VC"; // VC | PC | PS

  const settings = {
    VC: { fio2:40, peep:5.0, rr:16, tv:450 },
    PC: { fio2:40, peep:8.0, rr:18, pc:15 },
    PS: { fio2:30, peep:5.0, ps:5, backupRR:10, backupPC:15 }
  };

  const patient = { compliance:50, resistance:10, effort:0 };

  // ---------------- DOM ----------------
  const $ = id => document.getElementById(id);
  const canvas = $("scopeCanvas");
  const ctx = canvas.getContext("2d");

  function fitCanvas(){
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  window.addEventListener("resize", fitCanvas);

  // ---------------- SIM CLOCK ----------------
  const FS = 50;            // sim steps per second
  const DT = 1/FS;
  let simTime = 0;

  // breath state machine
  let phase = "insp";        // insp | exp
  let phaseTime = 0;
  let cycleStart = 0;

  // live signals (current instantaneous values)
  let Paw = 0, Flow = 0, Vol = 0;     // cmH2O, L/min, mL
  let lastVolPeakIns = 0;             // VTi this breath
  let lastVTe = 0, lastVTi = 0, lastPpeak = 0, lastRRdisplay = 16, lastMV = 0;
  let mvAccumVol = 0, mvWindowStart = 0;

  // history buffer for scrolling traces (3 panels)
  const HIST_SECONDS = 8;
  const histLen = HIST_SECONDS * FS;
  const hPaw = new Float32Array(histLen);
  const hFlow = new Float32Array(histLen);
  const hVol = new Float32Array(histLen);
  let histIdx = 0;

  function pushHist(p,f,v){
    hPaw[histIdx] = p; hFlow[histIdx] = f; hVol[histIdx] = v;
    histIdx = (histIdx+1) % histLen;
  }

  // patient trigger detection (for PS mode autocycling on effort)
  let triggered = false;

  // captured exactly once at the insp->exp transition: the starting volume for this breath's exhale decay
  let expStartVol = 0;

  // ---------------- PHYSIOLOGY STEP ----------------
  // Single compartment: Paw = PEEP + V/C + R*Flow  (Flow in L/s, V in L, R in cmH2O/L/s)
  function step(){
    const C = patient.compliance / 1000;   // mL/cmH2O -> L/cmH2O
    const R = patient.resistance;          // cmH2O/L/s
    const effort = patient.effort;         // 0-10

    if(mode === "VC"){
      const s = settings.VC;
      const totalCycle = 60 / s.rr;
      const ie = 0.5; // fraction inspiratory time (I:E ~ 1:2 -> insp ~ 0.33, but keep simple visual ~0.4)
      const Ti = totalCycle * 0.35;
      const Te = totalCycle - Ti;
      const targetVL = s.tv/1000;

      if(phase === "insp"){
        // decelerating-ish square flow to mimic image: near-constant flow producing volume ramp
        const peakFlowLs = targetVL / Ti * 1.15; // L/s, slightly higher than mean to taper at end
        let f;
        const frac = phaseTime/Ti;
        if(frac < 0.85){
          f = peakFlowLs;
        } else {
          f = peakFlowLs * (1 - (frac-0.85)/0.15);
        }
        Flow = Math.max(f,0);
        Vol += Flow*DT;
        if(Vol > targetVL) Vol = targetVL;
        Paw = s.peep + Vol/C + R*Flow;
        if(phaseTime >= Ti){
          phase = "exp"; phaseTime = 0;
          lastVTi = Math.round(Vol*1000);
          expStartVol = Vol; // capture once at the moment exhalation begins
        }
      } else {
        // passive exhalation: exponential decay from the fixed starting volume of this breath
        const tau = R*C;
        const v0 = expStartVol;
        Vol = v0 * Math.exp(-phaseTime/Math.max(tau,0.05));
        Flow = -(v0/Math.max(tau,0.05)) * Math.exp(-phaseTime/Math.max(tau,0.05));
        Paw = s.peep + Vol/C;
        if(phaseTime >= Te){
          lastVTe = Math.round(v0*1000);
          phase = "insp"; phaseTime = 0; Vol = 0;
        }
      }

    } else if(mode === "PC"){
      const s = settings.PC;
      const totalCycle = 60 / s.rr;
      const Ti = totalCycle * 0.35;
      const Te = totalCycle - Ti;
      const Ptarget = s.peep + s.pc;

      if(phase === "insp"){
        const riseTau = 0.06;
        Paw = Ptarget - (Ptarget - s.peep)*Math.exp(-phaseTime/riseTau);
        const drive = (Paw - s.peep - Vol/C);
        Flow = Math.max(drive / Math.max(R,1), 0);
        Vol += Flow*DT;
        if(phaseTime >= Ti){
          phase = "exp"; phaseTime = 0;
          lastVTi = Math.round(Vol*1000);
          expStartVol = Vol;
        }
      } else {
        const tau = R*C;
        const v0 = expStartVol;
        Vol = v0*Math.exp(-phaseTime/Math.max(tau,0.05));
        Flow = -(v0/Math.max(tau,0.05))*Math.exp(-phaseTime/Math.max(tau,0.05));
        Paw = s.peep + Vol/C;
        if(phaseTime >= Te){
          lastVTe = Math.round(v0*1000);
          phase = "insp"; phaseTime = 0; Vol = 0;
        }
      }

    } else if(mode === "PS"){
      const s = settings.PS;
      const Ptarget = s.peep + s.ps;
      // spontaneous-ish cycling: rate driven by effort (more effort -> faster, more variable)
      const baseRR = effort > 0 ? Math.min(28, s.backupRR*0.6 + effort*1.6) : s.backupRR;
      const totalCycle = 60/Math.max(baseRR,4);
      const Ti = totalCycle * 0.32;
      const Te = totalCycle - Ti;

      if(phase === "insp"){
        const riseTau = 0.05;
        const pcEff = effort>0 ? s.ps : s.ps; // PS magnitude fixed by setting
        Paw = Ptarget - (Ptarget - s.peep)*Math.exp(-phaseTime/riseTau);
        const drive = (Paw - s.peep - Vol/C);
        Flow = Math.max(drive / Math.max(R,1), 0) * (effort>0 ? 1.0 : 0.9);
        Vol += Flow*DT;
        // early termination (flow cycle-off) when flow decays - simplified by Ti
        if(phaseTime >= Ti){
          phase = "exp"; phaseTime = 0;
          lastVTi = Math.round(Vol*1000);
          expStartVol = Vol;
        }
      } else {
        const tau = R*C;
        const v0 = expStartVol;
        Vol = v0*Math.exp(-phaseTime/Math.max(tau,0.05));
        Flow = -(v0/Math.max(tau,0.05))*Math.exp(-phaseTime/Math.max(tau,0.05));
        // small negative deflection at end-exhalation if effort>0 (patient trigger)
        let trigDip = 0;
        if(effort>0){
          const triggerWindow = Te*0.85;
          if(phaseTime > triggerWindow){
            const tFrac = (phaseTime-triggerWindow)/(Te-triggerWindow+1e-6);
            trigDip = -0.3*effort*Math.sin(Math.min(tFrac,1)*Math.PI);
          }
        }
        Paw = s.peep + Vol/C + trigDip;
        if(phaseTime >= Te){
          lastVTe = Math.round(v0*1000);
          phase = "insp"; phaseTime = 0; Vol = 0;
        }
      }
    }

    phaseTime += DT;
    simTime += DT;

  }

  // We track Ppeak per-breath separately and reset cleanly:
  let breathPpeak = 0;
  let prevPhase = "insp";
  let lastBreathTimes = [];

  function trackAndDetectBoundary(){
    if(phase==="insp"){
      breathPpeak = Math.max(breathPpeak, Paw);
    }
    const expStarted = (prevPhase==="insp" && phase==="exp");
    const inspStarted = (prevPhase==="exp" && phase==="insp");

    if(expStarted){
      lastPpeak = breathPpeak;
      breathPpeak = 0;
    }
    if(inspStarted){
      lastBreathTimes.push(simTime);
      if(lastBreathTimes.length>6) lastBreathTimes.shift();
      if(lastBreathTimes.length>=2){
        const intervals = [];
        for(let i=1;i<lastBreathTimes.length;i++) intervals.push(lastBreathTimes[i]-lastBreathTimes[i-1]);
        const avg = intervals.reduce((a,b)=>a+b,0)/intervals.length;
        lastRRdisplay = Math.round(60/avg);
      }
    }
    prevPhase = phase;
  }

  // ---------------- MAIN LOOP ----------------
  let lastFrameWall = performance.now();
  let accum = 0;

  function loop(){
    const now = performance.now();
    let dtWall = (now - lastFrameWall)/1000;
    lastFrameWall = now;
    dtWall = Math.min(dtWall, 0.1);
    accum += dtWall;

    while(accum >= DT){
      step();
      trackAndDetectBoundary();
      pushHist(Paw, Flow*60, Vol*1000); // flow displayed L/min, vol displayed mL
      accum -= DT;
    }

    render();
    updateReadouts();
    updateLungVisual();
    requestAnimationFrame(loop);
  }

  // ---------------- RENDER ----------------
  function render(){
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0,0,w,h);

    const panelH = h/3;
    drawPanel(0, panelH, hPaw, scaleFor("paw"), "#e8a43d", "Paw cmH\u2082O", scaleLabels("paw"));
    drawPanel(panelH, panelH, hFlow, scaleFor("flow"), "#5fcf86", "FLOW l/min", scaleLabels("flow"));
    drawPanel(panelH*2, panelH, hVol, scaleFor("vol"), "#5cc9da", "V ml", scaleLabels("vol"), true);

    // divider lines
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0,panelH); ctx.lineTo(w,panelH);
    ctx.moveTo(0,panelH*2); ctx.lineTo(w,panelH*2);
    ctx.stroke();
  }

  function scaleFor(kind){
    if(kind==="paw") return { min:-5, max: 40 };
    if(kind==="flow") return { min:-100, max:100 };
    if(kind==="vol") return { min:0, max: Math.max(600, settingsTVorPC()*1.3) };
  }
  function settingsTVorPC(){
    if(mode==="VC") return settings.VC.tv;
    if(mode==="PC") return settings.PC.pc*40; // rough vol scale guess
    return 500;
  }
  function scaleLabels(kind){
    const sc = scaleFor(kind);
    return { top: Math.round(sc.max), bottom: Math.round(sc.min) };
  }

  function drawPanel(yTop, panelH, hist, scale, color, label, labels, baseline0){
    const w = canvas.clientWidth;
    const padTop = 14, padBottom = 6;
    const innerH = panelH - padTop - padBottom;

    function yFor(val){
      const t = (val - scale.min) / (scale.max - scale.min);
      return yTop + padTop + innerH * (1-t);
    }

    // gridline at zero / baseline
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    const zeroY = yFor(baseline0 ? scale.min : 0);
    ctx.beginPath(); ctx.moveTo(0,zeroY); ctx.lineTo(w,zeroY); ctx.stroke();

    // trace
    const n = histLen;
    const visibleSeconds = HIST_SECONDS;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for(let i=0;i<n;i++){
      const idx = (histIdx + i) % n; // oldest..newest across buffer
      const x = (i/n) * w;
      const y = yFor(hist[idx]);
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();

    // label
    ctx.fillStyle = "#8c9094";
    ctx.font = "10px IBM Plex Mono, monospace";
    ctx.fillText(String(labels.top), 4, yTop+11);
    ctx.fillText(String(labels.bottom), 4, yTop+panelH-3);
    ctx.fillStyle = "#aeb1b4";
    ctx.font = "11px IBM Plex Mono, monospace";
    ctx.fillText(label, 22, yTop+11);
  }

  // ---------------- READOUTS ----------------
  function updateReadouts(){
    $("vPpeak").textContent = lastPpeak>0 ? lastPpeak.toFixed(0) : "--";
    $("vRR").textContent = lastRRdisplay;
    const mv = (lastVTe/1000) * lastRRdisplay;
    $("vMV").textContent = mv.toFixed(1);
    $("vVTi").textContent = lastVTi || "--";
    $("vVTe").textContent = lastVTe || "--";
  }

  // ---------------- LUNG VISUAL ----------------
  const lungL = $("lungL"), lungR = $("lungR");
  const bronchL = $("bronchL"), bronchR = $("bronchR");
  const alvCircles = document.querySelectorAll(".alv");
  let lpCompLast = null, lpResLast = null;

  function updateLungVisual(){
    // Vol is current instantaneous lung volume in liters; normalize against a nominal max breath size
    const nominalMaxL = 0.8; // 800 mL ~ visual full-scale
    const fillFrac = Math.max(0, Math.min(1, Vol / nominalMaxL));

    // compliance affects how much the LUNG SHAPE itself expands per mL (stiff lungs barely move)
    // map compliance 10-100 -> expansion gain 0.55 - 1.15
    const C = patient.compliance;
    const expGain = 0.55 + (Math.min(Math.max(C,10),100) - 10) / 90 * 0.6;

    const lungScale = 1 + fillFrac * 0.22 * expGain;
    const alvScale  = 1 + fillFrac * 1.35 * expGain; // alveoli are the dramatic, legible part

    lungL.style.transform = `scale(${lungScale.toFixed(4)})`;
    lungR.style.transform = `scale(${lungScale.toFixed(4)})`;
    const brightness = 1 + fillFrac * 0.12;
    lungL.style.filter = `brightness(${brightness.toFixed(3)})`;
    lungR.style.filter = `brightness(${brightness.toFixed(3)})`;

    alvCircles.forEach(c=>{
      c.style.transform = `scale(${alvScale.toFixed(4)})`;
    });

    // resistance -> visually narrow / thicken & darken the airway (bronchi)
    const R = patient.resistance;
    const rFrac = Math.max(0, Math.min(1, (R - 4) / 36)); // 4 normal -> 40 severe
    const bronchWidth = 6 - rFrac * 3.2; // narrows as resistance climbs
    const bronchColor = rFrac > 0.5 ? "#8a5147" : "#c98a78";
    [bronchL, bronchR].forEach(b=>{
      b.setAttribute("stroke-width", bronchWidth.toFixed(1));
      b.style.stroke = bronchColor;
    });

    // compliance -> lung tissue color (stiff/fibrotic lungs read denser & darker)
    if(C !== lpCompLast){
      const stiffFrac = Math.max(0, Math.min(1, (100 - C) / 90)); // 0 normal/floppy -> 1 very stiff
      const lo = [186, 92, 80];   // darker stiffened red
      const hi = [255, 179, 168]; // healthy light pink
      const mix = lo.map((v,i)=> Math.round(v + (hi[i]-v)*(1-stiffFrac)));
      const col = `rgb(${mix[0]},${mix[1]},${mix[2]})`;
      document.querySelectorAll('#lungL path[fill^="url"], #lungR path[fill^="url"]').forEach(p=>{
        p.style.fill = col;
      });
      $("lpComp").textContent = C;
      lpCompLast = C;
    }
    if(R !== lpResLast){
      $("lpRes").textContent = R;
      lpResLast = R;
    }

    // Paw overdistension cue: alveoli flush warning-amber if pressure climbs high while near full inflation
    const overDist = Paw > 30 && fillFrac > 0.6;
    alvCircles.forEach(c=>{
      c.style.fill = overDist ? "#e0a23d" : "#e8978a";
    });
  }

  // ---------------- SETTINGS BAR (device bottom strip) ----------------
  function renderSettingsBar(){
    const bar = $("settingsBar");
    let tiles = [];
    if(mode==="VC"){
      const s = settings.VC;
      tiles = [
        ["FiO\u2082 %", s.fio2],
        ["PEEP", s.peep.toFixed(1)],
        ["RR", s.rr],
        ["Tidal volume", s.tv],
      ];
    } else if(mode==="PC"){
      const s = settings.PC;
      tiles = [
        ["FiO\u2082 %", s.fio2],
        ["PEEP", s.peep.toFixed(1)],
        ["RR", s.rr],
        ["PC above\nPEEP", s.pc],
      ];
    } else {
      const s = settings.PS;
      tiles = [
        ["FiO\u2082 %", s.fio2],
        ["PEEP", s.peep.toFixed(1)],
        ["PS above\nPEEP", s.ps],
        ["Backup RR", s.backupRR],
        ["Backup PC\nabove PEEP", s.backupPC],
      ];
    }
    bar.innerHTML = tiles.map(t=>(
      `<div class="settile" data-key="${t[0]}"><div class="lbl">${t[0].replace("\n","<br>")}</div><div class="val">${t[1]}</div></div>`
    )).join('') ;
  }

  function flashSettingsBar(){
    const bar = $("settingsBar");
    bar.querySelectorAll(".settile").forEach(el=>{
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    });
  }

  const modeNotes = {
    VC: "<b>Volume Control:</b> you set tidal volume + rate; the vent delivers a fixed flow pattern and <b>pressure is the result</b> — watch Ppeak rise as compliance drops or resistance climbs.",
    PC: "<b>Pressure Control:</b> you set a pressure target above PEEP; the vent holds that pressure and <b>volume is the result</b> — watch VTe fall if compliance drops, even though pressure stays fixed.",
    PS: "<b>PS/CPAP:</b> the patient triggers each breath; the vent only supports it with a fixed pressure boost. Raise <b>patient effort</b> to see spontaneous triggering, or set effort to 0 to see backup (apnea) breaths take over."
  };

  // ---------------- WIRE UP UI ----------------
  function switchMode(m){
    mode = m;
    document.querySelectorAll(".modebtn").forEach(b=>b.classList.toggle("active", b.dataset.mode===m));
    $("vcGroup").style.display = m==="VC" ? "" : "none";
    $("pcGroup").style.display = m==="PC" ? "" : "none";
    $("psGroup").style.display = m==="PS" ? "" : "none";

    renderSettingsBar();
    $("modeNote").innerHTML = modeNotes[m];
    // reset breath state for a clean transition
    phase = "insp"; phaseTime = 0; Vol = 0; breathPpeak = 0; expStartVol = 0;
    lastVTe = 0; lastVTi = 0; lastBreathTimes = [];
  }

  document.querySelectorAll(".modebtn").forEach(btn=>{
    btn.addEventListener("click", ()=> switchMode(btn.dataset.mode));
  });

  function bindSlider(sliderId, readoutId, store, key, isFloat){
    const el = $(sliderId);
    el.addEventListener("input", ()=>{
      const v = isFloat ? parseFloat(el.value) : parseInt(el.value,10);
      store[key] = v;
      $(readoutId).textContent = isFloat ? v.toFixed(1) : v;
      renderSettingsBar();
      flashSettingsBar();
    });
  }

  // VC
  bindSlider("sFiO2","rFiO2", settings.VC, "fio2", false);
  bindSlider("sPEEPvc","rPEEPvc", settings.VC, "peep", true);
  bindSlider("sRRvc","rRRvc", settings.VC, "rr", false);
  bindSlider("sTV","rTV", settings.VC, "tv", false);

  // PC
  bindSlider("sFiO2pc","rFiO2pc", settings.PC, "fio2", false);
  bindSlider("sPEEPpc","rPEEPpc", settings.PC, "peep", true);
  bindSlider("sRRpc","rRRpc", settings.PC, "rr", false);
  bindSlider("sPC","rPC", settings.PC, "pc", false);

  // PS
  bindSlider("sFiO2ps","rFiO2ps", settings.PS, "fio2", false);
  bindSlider("sPEEPps","rPEEPps", settings.PS, "peep", true);
  bindSlider("sPS","rPS", settings.PS, "ps", false);
  bindSlider("sBackupRR","rBackupRR", settings.PS, "backupRR", false);
  bindSlider("sBackupPC","rBackupPC", settings.PS, "backupPC", false);

  // Patient
  function bindPatient(sliderId, readoutId, key, fmt){
    const el = $(sliderId);
    el.addEventListener("input", ()=>{
      const v = parseFloat(el.value);
      patient[key] = v;
      $(readoutId).textContent = fmt ? fmt(v) : v;
    });
  }
  bindPatient("sComp","rComp","compliance");
  bindPatient("sRes","rRes","resistance");
  bindPatient("sEffort","rEffort","effort", v => v===0 ? "0 (none)" : v);

  document.querySelectorAll(".preset-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const p = btn.dataset.preset;
      if(p==="normal"){ setPatient(50,10,0); }
      if(p==="ards"){ setPatient(22,16,0); }
      if(p==="copd"){ setPatient(60,32,0); }
      if(p==="spontaneous"){ setPatient(50,10,6); if(mode!=="PS") switchMode("PS"); document.querySelector('[data-mode="PS"]').classList.add("active"); document.querySelector('[data-mode="VC"]').classList.remove("active"); document.querySelector('[data-mode="PC"]').classList.remove("active"); }
    });
  });
  function setPatient(c,r,e){
    patient.compliance=c; patient.resistance=r; patient.effort=e;
    $("sComp").value=c; $("rComp").textContent=c;
    $("sRes").value=r; $("rRes").textContent=r;
    $("sEffort").value=e; $("rEffort").textContent= e===0?"0 (none)":e;
  }

  // init
  fitCanvas();
  renderSettingsBar();
  requestAnimationFrame(loop);

})();