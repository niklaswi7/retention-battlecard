
(function(){
  'use strict';

  var el = function(id){ return document.getElementById(id); };
  var SpeechCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  var MODEL_F16 = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
  var MODEL_F32 = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';

  var state = {
    companies: [],
    yousee: null,
    active: false,
    scenario: null,
    history: [],
    engine: null,
    enginePromise: null,
    engineReady: false,
    modelMode: 'fallback',
    recognition: null,
    listening: false,
    busy: false,
    metrics: {
      data:false, roaming:false, price:false, music:false, bundle:false, closing:false, openQuestion:false
    }
  };

  var personaText = {
    price: 'Du er meget prisbevidst. Du sammenligner især månedspris og bliver ved med at vende tilbage til prisforskellen.',
    roaming: 'Du rejser flere gange om året og er bekymret for roaming, især uden for EU.',
    family: 'Du har flere mobilnumre i husstanden og tænker på den samlede pris for familien.',
    simple: 'Du vil helst have en enkel og billig mobilløsning uden unødige ekstrafunktioner.',
    skeptic: 'Du er skeptisk og tæt på at opsige. Du kræver konkrete grunde før du vil blive.'
  };

  function money(n){
    return Math.round(Number(n)||0).toLocaleString('da-DK') + ' kr.';
  }

  function effectivePrice(plan){
    return Number(plan && plan.campaignPrice != null ? plan.campaignPrice : plan && (plan.monthlyPrice != null ? plan.monthlyPrice : plan.price) || 0);
  }

  function safeArray(v){ return Array.isArray(v) ? v : []; }

  async function loadDatabase(){
    try{
      var listRes = await fetch('data/companies.json', {cache:'no-store'});
      if(!listRes.ok) throw new Error('companies');
      var list = await listRes.json();
      var loaded = [];
      for(var i=0;i<list.length;i++){
        var item = list[i];
        var r = await fetch('data/' + item.file, {cache:'no-store'});
        if(!r.ok) continue;
        var d = await r.json();
        loaded.push({name:item.name, file:item.file, data:d});
      }
      state.companies = loaded;
      try{
        var yr = await fetch('data/yousee.json', {cache:'no-store'});
        if(yr.ok) state.yousee = await yr.json();
      }catch(_){}
      populateCompanies();
      setStatus('Klar til opsætning');
    }catch(err){
      setStatus('Kunne ikke indlæse trainer-data');
      if(el('trainerStart')) el('trainerStart').disabled = true;
    }
  }

  function populateCompanies(){
    var select = el('trainerCompany');
    if(!select) return;
    select.innerHTML = state.companies.map(function(c,i){
      return '<option value="' + i + '">' + escapeHtml(c.name) + '</option>';
    }).join('');
    populatePlans();
  }

  function populatePlans(){
    var company = state.companies[Number(el('trainerCompany').value || 0)];
    var select = el('trainerPlan');
    if(!company || !select) return;
    select.innerHTML = safeArray(company.data.subscriptions).map(function(p,i){
      return '<option value="' + i + '">' + escapeHtml(p.name) + ' · ' + money(effectivePrice(p)) + '/md.</option>';
    }).join('');
  }

  function featureStatus(){
    var gpu = !!navigator.gpu;
    var voice = !!SpeechCtor;
    el('trainerGpuStatus').textContent = gpu ? 'WebGPU: Ja' : 'WebGPU: Nej · fallback';
    el('trainerVoiceStatus').textContent = voice ? 'Voice: Ja' : 'Voice: Tekst-mode';
    if(!gpu){
      setAiBadge('fallback','Scripted fallback');
    }
  }

  function setStatus(text){ if(el('trainerStatus')) el('trainerStatus').textContent = text; }

  function setAiBadge(kind,text){
    var badge = el('trainerAiBadge');
    if(!badge) return;
    badge.className = 'trainer-badge' + (kind ? ' ' + kind : '');
    badge.textContent = text;
  }

  function toggleTrainer(){
    var body = el('trainerBody');
    var btn = el('trainerToggle');
    var open = body.hasAttribute('hidden');
    if(open){
      body.removeAttribute('hidden');
      btn.textContent = 'Luk trainer';
      btn.setAttribute('aria-expanded','true');
    }else{
      body.setAttribute('hidden','');
      btn.textContent = 'Åbn trainer';
      btn.setAttribute('aria-expanded','false');
      window.speechSynthesis && window.speechSynthesis.cancel();
    }
  }

  function makeScenario(){
    var company = state.companies[Number(el('trainerCompany').value || 0)];
    if(!company) return null;
    var plan = safeArray(company.data.subscriptions)[Number(el('trainerPlan').value || 0)];
    if(!plan) return null;
    var data = Number(plan.data);
    var usage = data === -1 ? 48 : Math.max(2, Math.min(data, Math.round(data * 0.45)));
    var persona = el('trainerPersona').value;
    if(persona === 'simple') usage = data === -1 ? 18 : Math.max(2, Math.min(data, Math.round(data * 0.28)));
    if(persona === 'roaming') usage = data === -1 ? 35 : Math.max(5, Math.min(data, Math.round(data * 0.5)));
    return {
      company: company.data,
      plan: plan,
      persona: persona,
      difficulty: el('trainerDifficulty').value,
      saveRights: el('trainerSaveRights').checked,
      usage: usage
    };
  }

  function startTraining(){
    state.scenario = makeScenario();
    if(!state.scenario) return;
    state.active = true;
    state.history = [];
    state.busy = false;
    state.metrics = {data:false,roaming:false,price:false,music:false,bundle:false,closing:false,openQuestion:false};

    el('trainerTranscript').innerHTML = '';
    el('trainerFeedback').hidden = true;
    el('trainerInput').disabled = false;
    el('trainerSend').disabled = false;
    el('trainerFinish').disabled = false;
    el('trainerMic').disabled = !SpeechCtor;
    el('trainerInput').focus();

    var intro = introText();
    addMessage('customer', intro);
    state.history.push({role:'assistant',content:intro});
    speak(intro);
    setStatus('Samtalen er i gang');

    if(navigator.gpu){
      ensureLocalModel();
    }else{
      setAiBadge('fallback','Scripted fallback');
    }
  }

  function introText(){
    var s = state.scenario;
    var p = effectivePrice(s.plan);
    if(s.persona === 'skeptic'){
      return 'Hej. Jeg ringer, fordi jeg seriøst overvejer at skifte. Jeg har kigget på ' + s.company.company + ' ' + s.plan.name + ' til ' + money(p) + ' om måneden, og jeg kan ikke rigtig se, hvorfor jeg skal blive.';
    }
    if(s.persona === 'roaming'){
      return 'Hej. Jeg har kigget på ' + s.company.company + ' ' + s.plan.name + ' til ' + money(p) + ' om måneden. Jeg rejser en del, så pris og roaming er det, jeg især sammenligner.';
    }
    if(s.persona === 'family'){
      return 'Hej. Jeg sammenligner vores mobilabonnementer derhjemme, og ' + s.company.company + ' ' + s.plan.name + ' til ' + money(p) + ' om måneden ser interessant ud. Vi har flere numre, så den samlede pris betyder meget.';
    }
    return 'Hej. Jeg har set ' + s.company.company + ' ' + s.plan.name + ' til ' + money(p) + ' om måneden. Det virker billigere end det, jeg har nu, så jeg overvejer at skifte.';
  }

  async function ensureLocalModel(){
    if(state.engineReady || state.enginePromise) return state.enginePromise;
    state.enginePromise = (async function(){
      try{
        setAiBadge('loading','Lokal AI indlæses…');
        showProgress(true);
        var webllm = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm');
        var adapter = await navigator.gpu.requestAdapter();
        if(!adapter) throw new Error('Ingen WebGPU-adapter');
        var modelId = adapter.features && adapter.features.has('shader-f16') ? MODEL_F16 : MODEL_F32;
        state.engine = await webllm.CreateMLCEngine(modelId, {
          initProgressCallback: function(report){
            var pct = 0;
            if(typeof report.progress === 'number') pct = Math.max(0,Math.min(100,Math.round(report.progress*100)));
            el('trainerProgressBar').style.width = pct + '%';
            el('trainerProgressPct').textContent = pct + '%';
            el('trainerProgressText').textContent = report.text || 'Indlæser lokal AI…';
          },
          logLevel:'WARN'
        });
        state.engineReady = true;
        state.modelMode = 'llm';
        setAiBadge('ready','Lokal AI klar');
        setStatus(state.active ? 'Samtalen er i gang · lokal AI klar' : 'Lokal AI klar');
        setTimeout(function(){ showProgress(false); }, 900);
      }catch(err){
        console.warn('Local trainer model failed:', err);
        state.engineReady = false;
        state.modelMode = 'fallback';
        setAiBadge('fallback','Scripted fallback');
        el('trainerProgressText').textContent = 'Lokal AI kunne ikke indlæses. Trainer fortsætter i fallback-mode.';
        el('trainerProgressPct').textContent = '';
        el('trainerProgressBar').style.width = '100%';
        setTimeout(function(){ showProgress(false); }, 2200);
      }finally{
        state.enginePromise = null;
      }
    })();
    return state.enginePromise;
  }

  function showProgress(show){
    if(show) el('trainerProgressWrap').removeAttribute('hidden');
    else el('trainerProgressWrap').setAttribute('hidden','');
  }

  async function submitEmployee(text){
    text = String(text || '').trim();
    if(!state.active || !text || state.busy) return;
    state.busy = true;
    el('trainerSend').disabled = true;
    el('trainerInput').disabled = true;

    addMessage('employee', text);
    state.history.push({role:'user',content:text});
    trackMetrics(text);
    el('trainerInput').value = '';

    var thinking = addMessage('customer','Tænker…',true);
    var reply = '';
    try{
      if(state.engineReady){
        reply = await localLlmReply();
      }
      if(!reply) reply = fallbackReply(text);
    }catch(err){
      console.warn('Local LLM response failed:',err);
      reply = fallbackReply(text);
    }
    if(thinking && thinking.parentNode) thinking.parentNode.removeChild(thinking);
    addMessage('customer', reply);
    state.history.push({role:'assistant',content:reply});
    speak(reply);

    state.busy = false;
    el('trainerSend').disabled = false;
    el('trainerInput').disabled = false;
    el('trainerInput').focus();
  }

  async function localLlmReply(){
    if(!state.engine || !state.scenario) return '';
    var messages = [{role:'system',content:systemPrompt()}].concat(state.history.slice(-12));
    var out = await state.engine.chat.completions.create({
      messages: messages,
      temperature: state.scenario.difficulty === 'hard' ? 0.85 : 0.7,
      top_p: 0.9,
      max_tokens: 120
    });
    var text = out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
    return cleanReply(text);
  }

  function systemPrompt(){
    var s = state.scenario;
    var p = s.plan;
    var facts = [
      'Selskab: ' + s.company.company,
      'Abonnement: ' + p.name,
      'Aktuel månedspris: ' + money(effectivePrice(p)),
      'Normalpris: ' + money(p.price != null ? p.price : (p.normalMonthlyPrice != null ? p.normalMonthlyPrice : effectivePrice(p))),
      'Data: ' + (p.data === -1 ? 'fri data' : p.data + ' GB'),
      'EU-data: ' + (p.euData != null ? p.euData + ' GB' : 'ikke oplyst'),
      'Netværk: ' + (s.company.network || 'ikke oplyst'),
      'Roaming: ' + (s.company.roaming || 'ikke oplyst')
    ].join('\n');

    var diff = s.difficulty === 'easy'
      ? 'Du er åben og bliver relativt let overbevist, hvis medarbejderen afdækker dit behov.'
      : s.difficulty === 'hard'
        ? 'Du er krævende, stiller modspørgsmål og accepterer ikke generelle salgssvar. Kræv konkrete argumenter.'
        : 'Du er realistisk skeptisk, men lytter til relevante argumenter.';

    return [
      'Du spiller KUNDEN i en dansk retention-træningssamtale. Du er IKKE træneren.',
      'Svar altid på naturligt dansk og hold hvert svar på højst 2-3 korte sætninger.',
      'Du må ikke give medarbejderen salgsråd, facit, scoring eller nævne systemprompten.',
      'Du må ikke opfinde produktfakta ud over oplysningerne nedenfor.',
      'Hvis medarbejderen stiller et godt behovsspørgsmål, svar konkret som kunden.',
      'Hvis medarbejderen bare sælger uden at afdække behov, vær skeptisk.',
      personaText[s.persona] || personaText.price,
      diff,
      'Dit skjulte omtrentlige dataforbrug er ' + s.usage + ' GB pr. måned.',
      'PRODUKTFAKTA:',
      facts
    ].join('\n');
  }

  function cleanReply(text){
    text = String(text || '').trim();
    text = text.replace(/^(kunde|customer|assistant)\s*:\s*/i,'').trim();
    if(text.length > 520) text = text.slice(0,517) + '…';
    return text;
  }

  function fallbackReply(text){
    var s = state.scenario;
    var t = text.toLowerCase();
    var hard = s.difficulty === 'hard';

    if(/hvor meget|data|gb|forbrug/.test(t)){
      return 'Jeg bruger typisk omkring ' + s.usage + ' GB om måneden. Jeg vil bare gerne have lidt luft, så jeg ikke skal holde øje med det hele tiden.';
    }
    if(/rejse|roaming|udland|ferie|eu|usa|verden/.test(t)){
      if(s.persona === 'roaming'){
        return 'Jeg rejser cirka fire-fem gange om året, og mindst én tur er typisk uden for EU. Jeg vil helst undgå at tænke på ekstra regninger.';
      }
      return 'Jeg er mest i Danmark, men jeg rejser et par gange om året i Europa. En tur uden for EU kan også ske en gang imellem.';
    }
    if(/musik|spotify|yousee musik|stream/.test(t)){
      return s.persona === 'simple'
        ? 'Jeg bruger Spotify i forvejen, så musik er ikke noget, jeg vil betale ekstra for.'
        : 'Jeg bruger musik næsten hver dag. Hvis det reelt erstatter noget, jeg allerede betaler for, er det interessant.';
    }
    if(/internet|tv|samle|familie|flere nummer|husstand/.test(t)){
      return s.persona === 'family'
        ? 'Vi har flere mobilnumre derhjemme, og vi har også internet. Men det skal være tydeligt, hvad vi faktisk sparer samlet.'
        : 'Jeg vil helst ikke ændre alt muligt andet bare for at få en mobilpris. Hvad får jeg konkret ud af at samle det?';
    }
    if(/pris|dyr|billig|koster|kr\.|kroner|rabat|tilbud/.test(t)){
      return hard
        ? 'Men det er stadig månedsprisen, jeg kan se på min konto hver måned. Hvorfor skal jeg betale mere end ' + money(effectivePrice(s.plan)) + '?'
        : 'Prisen er nok det vigtigste for mig. Hvis jeres løsning er dyrere, skal forskellen give mig noget, jeg faktisk bruger.';
    }
    if(/blive|beholde|fortsætte|aftale|skal vi|kan jeg sætte|oprette/.test(t)){
      return hard
        ? 'Jeg er ikke klar til at sige ja endnu. Hvad er den konkrete fordel for mig sammenlignet med det tilbud, jeg har kigget på?'
        : 'Det kommer an på den samlede pris og om det passer bedre til mit behov. Hvad vil du konkret foreslå?';
    }
    return hard
      ? 'Det lyder lidt generelt. Hvad betyder det konkret for mig og min månedlige pris?'
      : 'Okay. Hvad vil du gerne vide om mit forbrug, før du anbefaler noget?';
  }

  function trackMetrics(text){
    var t = text.toLowerCase();
    if(/data|gb|forbrug|bruger du/.test(t)) state.metrics.data = true;
    if(/roaming|rejse|udland|eu|ferie/.test(t)) state.metrics.roaming = true;
    if(/pris|koster|billig|dyr|budget/.test(t)) state.metrics.price = true;
    if(/musik|spotify|stream/.test(t)) state.metrics.music = true;
    if(/internet|tv|samle|familie|husstand|flere/.test(t)) state.metrics.bundle = true;
    if(/skal vi|må jeg|kan jeg oprette|vil du|så gør vi|beholde dig|aftale/.test(t)) state.metrics.closing = true;
    if(/\?/.test(text) || /hvad|hvordan|hvor meget|hvilke|hvor ofte|fortæl/.test(t)) state.metrics.openQuestion = true;
  }

  function addMessage(role,text,thinking){
    var transcript = el('trainerTranscript');
    var node = document.createElement('div');
    node.className = 'trainer-msg ' + role + (thinking ? ' thinking' : '');
    var label = role === 'employee' ? 'Medarbejder' : 'Kunde';
    node.innerHTML = '<small>' + label + '</small>' + escapeHtml(text);
    transcript.appendChild(node);
    transcript.scrollTop = transcript.scrollHeight;
    return node;
  }

  function speak(text){
    if(!('speechSynthesis' in window)) return;
    try{
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'da-DK';
      u.rate = 0.97;
      var voices = window.speechSynthesis.getVoices();
      var da = voices.find(function(v){ return String(v.lang||'').toLowerCase().indexOf('da') === 0; });
      if(da) u.voice = da;
      window.speechSynthesis.speak(u);
    }catch(_){}
  }

  async function startMic(){
    if(!state.active || !SpeechCtor || state.listening) return;
    try{
      var rec = new SpeechCtor();
      state.recognition = rec;
      rec.lang = 'da-DK';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.continuous = false;

      if('processLocally' in rec && typeof SpeechCtor.available === 'function'){
        try{
          var availability = await SpeechCtor.available({langs:['da-DK'],processLocally:true,quality:'dictation'});
          if(availability === 'available'){
            rec.processLocally = true;
            el('trainerVoiceStatus').textContent = 'Voice: On-device';
          }else if(availability === 'downloadable' || availability === 'downloading'){
            setStatus('Installerer dansk on-device tale…');
            var installed = await SpeechCtor.install({langs:['da-DK'],processLocally:true,quality:'dictation'});
            if(installed){
              rec.processLocally = true;
              el('trainerVoiceStatus').textContent = 'Voice: On-device';
            }else{
              rec.processLocally = false;
              el('trainerVoiceStatus').textContent = 'Voice: Browser-service';
            }
          }else{
            rec.processLocally = false;
            el('trainerVoiceStatus').textContent = 'Voice: Browser-service';
          }
        }catch(_){
          rec.processLocally = false;
          el('trainerVoiceStatus').textContent = 'Voice: Browser-service';
        }
      }else if('processLocally' in rec){
        rec.processLocally = true;
      }else{
        el('trainerVoiceStatus').textContent = 'Voice: Browser-service';
      }

      rec.onstart = function(){
        state.listening = true;
        el('trainerMic').classList.add('listening');
        el('trainerMic').textContent = '■';
        setStatus('Lytter…');
      };
      rec.onend = function(){
        state.listening = false;
        el('trainerMic').classList.remove('listening');
        el('trainerMic').textContent = '🎙';
        if(state.active && !state.busy) setStatus(state.engineReady ? 'Samtalen er i gang · lokal AI klar' : 'Samtalen er i gang');
      };
      rec.onerror = function(ev){
        setStatus('Mikrofon: ' + (ev.error || 'fejl') + ' · skriv evt. svaret');
      };
      rec.onresult = function(ev){
        var result = ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript;
        if(result){
          el('trainerInput').value = result;
          submitEmployee(result);
        }
      };
      rec.start();
    }catch(err){
      setStatus('Mikrofon kunne ikke startes · brug tekstfeltet');
    }
  }

  function finishTraining(){
    if(!state.active) return;
    state.active = false;
    if(state.recognition && state.listening){
      try{ state.recognition.stop(); }catch(_){}
    }
    window.speechSynthesis && window.speechSynthesis.cancel();
    el('trainerInput').disabled = true;
    el('trainerSend').disabled = true;
    el('trainerMic').disabled = true;
    el('trainerFinish').disabled = true;
    setStatus('Træning afsluttet');
    renderFeedback();
  }

  function renderFeedback(){
    var m = state.metrics;
    var checks = [
      ['Dataforbrug',m.data],
      ['Roaming/rejser',m.roaming],
      ['Pris/budget',m.price],
      ['Musik/streaming',m.music],
      ['Samlebehov/familie',m.bundle],
      ['Åbne spørgsmål',m.openQuestion],
      ['Forsøg på lukning',m.closing]
    ];
    var score = Math.round(checks.filter(function(x){return x[1];}).length / checks.length * 100);
    var good = checks.filter(function(x){return x[1];}).map(function(x){return x[0];});
    var missed = checks.filter(function(x){return !x[1];}).map(function(x){return x[0];});
    var match = findYouseeMatch();

    var box = el('trainerFeedback');
    box.innerHTML =
      '<h3>Træningsfeedback</h3>' +
      '<div class="trainer-score"><strong>' + score + '%</strong><span>behovspunkter dækket</span></div>' +
      '<div class="trainer-feedback-grid">' +
        '<div class="trainer-feedback-box"><b>✓ Afdækket</b><ul>' +
          (good.length ? good.map(function(x){return '<li>' + escapeHtml(x) + '</li>';}).join('') : '<li>Ingen registrerede behovspunkter endnu</li>') +
        '</ul></div>' +
        '<div class="trainer-feedback-box"><b>→ Prøv næste gang</b><ul>' +
          (missed.length ? missed.slice(0,5).map(function(x){return '<li>' + escapeHtml(x) + '</li>';}).join('') : '<li>Du kom omkring alle de målte områder</li>') +
        '</ul></div>' +
      '</div>' +
      (match ? '<div class="trainer-match"><b>Relevant YouSee-match ud fra scenariet:</b> ' + escapeHtml(match.name) + ' · ' + money(match.monthlyPrice != null ? match.monthlyPrice : match.price) + '/md.' + (match.saveOnly ? ' · SAVE/ATL/BTL' : '') + '</div>' : '');
    box.hidden = false;
  }

  function findYouseeMatch(){
    if(!state.yousee || !state.scenario) return null;
    var allowSave = state.scenario.saveRights;
    var usage = state.scenario.usage;
    var plans = safeArray(state.yousee.subscriptions).filter(function(p){
      if(p.saveOnly && !allowSave) return false;
      var d = Number(p.data);
      return d === -1 || d >= usage;
    });
    plans.sort(function(a,b){
      var ap = Number(a.monthlyPrice != null ? a.monthlyPrice : a.price || 99999);
      var bp = Number(b.monthlyPrice != null ? b.monthlyPrice : b.price || 99999);
      return ap-bp;
    });
    return plans[0] || null;
  }

  function escapeHtml(v){
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  function bind(){
    el('trainerToggle').addEventListener('click',toggleTrainer);
    el('trainerCompany').addEventListener('change',populatePlans);
    el('trainerStart').addEventListener('click',startTraining);
    el('trainerMic').addEventListener('click',function(){
      if(state.listening && state.recognition){
        try{ state.recognition.stop(); }catch(_){}
      }else{
        startMic();
      }
    });
    el('trainerForm').addEventListener('submit',function(e){
      e.preventDefault();
      submitEmployee(el('trainerInput').value);
    });
    el('trainerFinish').addEventListener('click',finishTraining);
  }

  function init(){
    if(!el('trainerSection')) return;
    featureStatus();
    bind();
    loadDatabase();
  }

  init();
})();
