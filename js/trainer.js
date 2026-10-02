
(function(){
  'use strict';

  var el = function(id){ return document.getElementById(id); };
  var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  var WHISPER_MODEL = 'onnx-community/whisper-tiny';
  var MODEL_F16 = 'SmolLM2-360M-Instruct-q4f16_1-MLC';
  var MODEL_F32 = 'SmolLM2-360M-Instruct-q4f32_1-MLC';

  var nativeFetch = window.fetch.bind(window);

  function hfProxyUrl(value){
    try{
      var raw = typeof value === 'string' ? value : (value instanceof URL ? value.href : value && value.url);
      if(!raw || raw.indexOf('https://huggingface.co/') !== 0) return null;
      var u = new URL(raw);
      return window.location.origin + '/hf/' + u.pathname.replace(/^\//,'') + u.search;
    }catch(_){
      return null;
    }
  }

  window.fetch = function(input,init){
    var proxied = hfProxyUrl(input);
    if(!proxied) return nativeFetch(input,init);
    if(typeof Request !== 'undefined' && input instanceof Request){
      try{
        return nativeFetch(new Request(proxied,input),init);
      }catch(_){}
    }
    return nativeFetch(proxied,init);
  };

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
    modelName: '',
    modelError: '',
    browserAiSession: null,
    browserAiReady: false,
    browserAiError: '',
    audioStream: null,
    audioContext: null,
    audioSource: null,
    audioProcessor: null,
    audioSink: null,
    audioChunks: [],
    audioSamples: 0,
    audioSampleRate: 48000,
    recording: false,
    recordingStartedAt: 0,
    lastMeterUpdate: 0,
    transcriber: null,
    transcriberPromise: null,
    whisperReady: false,
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
    var mic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && AudioContextCtor);
    el('trainerGpuStatus').textContent = ('LanguageModel' in window) ? 'Browser-AI: Ja' : (gpu ? 'WebGPU: Ja' : 'AI: fallback');
    el('trainerVoiceStatus').textContent = mic ? 'Mic: Klar · Whisper ved første brug' : 'Mic: Ikke understøttet';
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
    el('trainerMic').disabled = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && AudioContextCtor);
    el('trainerInput').focus();

    var intro = introText();
    addMessage('customer', intro);
    state.history.push({role:'assistant',content:intro});
    speak(intro);
    setStatus('Samtalen er i gang');

    if(!state.engineReady && !state.browserAiReady){
      state.modelError = '';
      state.browserAiError = '';
      ensureLocalModel();
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
    if(state.engineReady || state.browserAiReady) return state.browserAiSession || state.engine;
    if(state.enginePromise) return state.enginePromise;

    state.enginePromise = (async function(){
      state.modelError = '';
      state.browserAiError = '';
      showProgress(true);

      // 1) Prefer the browser's built-in Prompt API when available.
      // This avoids third-party model downloads from the webpage entirely.
      if('LanguageModel' in window){
        try{
          setAiBadge('loading','Prøver browserens AI…');
          el('trainerProgressText').textContent = 'Tjekker browserens indbyggede AI…';
          el('trainerProgressPct').textContent = '';
          el('trainerProgressBar').style.width = '12%';

          var availability = await LanguageModel.availability();
          if(availability !== 'unavailable'){
            state.browserAiSession = await LanguageModel.create({
              initialPrompts:[
                {role:'system',content:systemPrompt()}
              ],
              monitor:function(m){
                m.addEventListener('downloadprogress',function(e){
                  var pct = Math.round((e.loaded || 0) * 100);
                  el('trainerProgressBar').style.width = pct + '%';
                  el('trainerProgressPct').textContent = pct + '%';
                  el('trainerProgressText').textContent = 'Browser-AI downloades lokalt…';
                });
              }
            });
            state.browserAiReady = true;
            state.modelMode = 'browser-ai';
            state.modelName = 'Browser LanguageModel';
            setAiBadge('ready','Browser-AI klar');
            el('trainerProgressBar').style.width = '100%';
            el('trainerProgressPct').textContent = '100%';
            el('trainerProgressText').textContent = 'Browserens indbyggede AI er klar';
            setStatus(state.active ? 'Samtalen er i gang · browser-AI klar' : 'Browser-AI klar');
            setTimeout(function(){ showProgress(false); },900);
            return state.browserAiSession;
          }
          state.browserAiError = 'LanguageModel er unavailable';
        }catch(err){
          state.browserAiError = err && err.message ? err.message : String(err || 'Ukendt browser-AI fejl');
          console.warn('Built-in browser AI unavailable:',err);
        }
      }

      // 2) WebLLM fallback. Probe the two external hosts separately first,
      // so corporate network blocks are visible instead of just "Failed to fetch".
      try{
        if(!navigator.gpu) throw new Error('WebGPU er ikke tilgængelig i denne browser eller er deaktiveret af enhedspolitik');

        setAiBadge('loading','Tester AI-netværk…');
        el('trainerProgressText').textContent = 'Tester adgang til jsDelivr…';
        el('trainerProgressBar').style.width = '18%';

        await probeUrl(
          'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm',
          'jsDelivr'
        );

        el('trainerProgressText').textContent = 'Tester Cloudflare model-proxy…';
        el('trainerProgressBar').style.width = '25%';

        await probeUrl(
          '/hf/mlc-ai/SmolLM2-360M-Instruct-q4f16_1-MLC/resolve/main/mlc-chat-config.json',
          'Cloudflare model-proxy'
        );

        var adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
        if(!adapter) throw new Error('Browseren kunne ikke oprette en WebGPU-adapter');

        setAiBadge('loading','WebLLM indlæses…');
        el('trainerProgressText').textContent = 'Henter WebLLM…';

        // Direct jsDelivr URL instead of the esm.run alias.
        var webllm = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm');

        var hasF16 = !!(adapter.features && adapter.features.has('shader-f16'));
        var modelId = hasF16 ? MODEL_F16 : MODEL_F32;
        state.modelName = modelId;
        setAiBadge('loading',hasF16 ? 'Lokal AI · 376 MB' : 'Lokal AI · 580 MB');

        var originalModel = webllm.prebuiltAppConfig.model_list.find(function(item){
          return item.model_id === modelId;
        });
        if(!originalModel) throw new Error('WebLLM mangler modeldefinitionen ' + modelId);

        var modelLib = originalModel.model_lib;
        var rawPrefix = 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/';
        if(modelLib && modelLib.indexOf(rawPrefix) === 0){
          modelLib = 'https://cdn.jsdelivr.net/gh/mlc-ai/binary-mlc-llm-libs@main/' + modelLib.slice(rawPrefix.length);
        }

        var appConfig = {
          cacheBackend:'cache',
          model_list:[
            Object.assign({},originalModel,{
              model:window.location.origin + '/hf/mlc-ai/' + modelId,
              model_lib:modelLib
            })
          ]
        };

        state.engine = await webllm.CreateMLCEngine(
          modelId,
          {
            appConfig:appConfig,
            initProgressCallback:function(report){
              var pct = 0;
              if(typeof report.progress === 'number'){
                pct = Math.max(0,Math.min(100,Math.round(report.progress*100)));
                el('trainerProgressBar').style.width = pct + '%';
                el('trainerProgressPct').textContent = pct + '%';
              }
              el('trainerProgressText').textContent = report.text || ('Indlæser ' + modelId + '…');
            },
            logLevel:'INFO'
          },
          {context_window_size:2048}
        );

        state.engineReady = true;
        state.modelMode = 'llm';
        setAiBadge('ready','Lokal AI klar');
        el('trainerProgressBar').style.width = '100%';
        el('trainerProgressPct').textContent = '100%';
        el('trainerProgressText').textContent = 'Lokal AI klar';
        setStatus(state.active ? 'Samtalen er i gang · lokal AI klar' : 'Lokal AI klar');
        setTimeout(function(){ showProgress(false); },900);
        return state.engine;
      }catch(err){
        console.error('Local trainer model failed:',err);
        state.engine = null;
        state.engineReady = false;
        state.modelMode = 'fallback';
        state.modelError = err && err.message ? err.message : String(err || 'Ukendt fejl');
        setAiBadge('fallback','AI-netværk blokeret');
        el('trainerProgressText').textContent =
          'AI fejl: ' + state.modelError +
          (state.browserAiError ? ' · Browser-AI: ' + state.browserAiError : '');
        el('trainerProgressPct').textContent = '';
        el('trainerProgressBar').style.width = '100%';
        setStatus('AI kunne ikke starte · scripted fallback er aktiv');
        return null;
      }finally{
        state.enginePromise = null;
      }
    })();

    return state.enginePromise;
  }

  async function probeUrl(url,label){
    try{
      var r = await fetch(url,{cache:'no-store',mode:'cors'});
      if(!r.ok) throw new Error('HTTP ' + r.status);
      // Consume only small responses used by these probes.
      await r.text();
      return true;
    }catch(err){
      throw new Error(label + ' fejlede (' + (err && err.message ? err.message : 'Failed to fetch') + ')');
    }
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
      if(!state.engineReady && !state.browserAiReady && !state.modelError){
        setStatus('Venter på AI…');
        await ensureLocalModel();
      }
      if(state.browserAiReady){
        reply = await browserAiReply(text);
      }else if(state.engineReady){
        reply = await localLlmReply();
      }
      if(!reply){
        reply = fallbackReply(text);
      }
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

  async function browserAiReply(text){
    if(!state.browserAiSession) return '';
    try{
      var prompt = [
        'Continue the roleplay as the customer.',
        'The employee just said in Danish:',
        text,
        'Reply only as the customer, naturally and briefly in Danish. Do not coach the employee.'
      ].join('\n');
      var out = await state.browserAiSession.prompt(prompt);
      return cleanReply(out);
    }catch(err){
      console.warn('Browser AI reply failed:',err);
      state.browserAiError = err && err.message ? err.message : String(err || 'Browser AI error');
      return '';
    }
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
    if(!state.active || state.busy || state.recording) return;
    if(!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && AudioContextCtor)){
      setStatus('Denne browser kan ikke optage mikrofon · brug tekstfeltet');
      return;
    }

    try{
      if('speechSynthesis' in window){
        try{ window.speechSynthesis.cancel(); }catch(_){}
      }

      setStatus('Anmoder om mikrofontilladelse…');
      var stream = await navigator.mediaDevices.getUserMedia({
        audio:{
          echoCancellation:true,
          noiseSuppression:true,
          autoGainControl:true,
          channelCount:1
        }
      });

      var ctx = new AudioContextCtor({latencyHint:'interactive'});
      if(ctx.state === 'suspended') await ctx.resume();

      var source = ctx.createMediaStreamSource(stream);
      var processor = ctx.createScriptProcessor(4096,1,1);
      var sink = ctx.createGain();
      sink.gain.value = 0;

      state.audioStream = stream;
      state.audioContext = ctx;
      state.audioSource = source;
      state.audioProcessor = processor;
      state.audioSink = sink;
      state.audioChunks = [];
      state.audioSamples = 0;
      state.audioSampleRate = ctx.sampleRate || 48000;
      state.recording = true;
      state.recordingStartedAt = Date.now();
      state.lastMeterUpdate = 0;

      processor.onaudioprocess = function(ev){
        if(!state.recording) return;
        var input = ev.inputBuffer.getChannelData(0);
        var copy = new Float32Array(input.length);
        copy.set(input);
        state.audioChunks.push(copy);
        state.audioSamples += copy.length;

        var now = Date.now();
        if(now - state.lastMeterUpdate > 250){
          state.lastMeterUpdate = now;
          var sum = 0;
          for(var i=0;i<input.length;i++) sum += input[i]*input[i];
          var rms = Math.sqrt(sum / Math.max(1,input.length));
          var level = Math.min(100,Math.round(rms * 420));
          var sec = Math.max(0,(now-state.recordingStartedAt)/1000);
          el('trainerVoiceStatus').textContent = 'Mic: ' + level + '% · ' + sec.toFixed(1) + ' sek';
          setStatus('Optager lokalt · tryk stop når du er færdig');
        }
      };

      source.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);

      el('trainerMic').classList.add('listening');
      el('trainerMic').textContent = '■';
      el('trainerMic').setAttribute('aria-label','Stop optagelse og transskriber');
      el('trainerMic').title = 'Stop og transskriber';
      el('trainerVoiceStatus').textContent = 'Mic: Optager…';
      setStatus('Optager lokalt · tryk stop når du er færdig');
    }catch(err){
      console.warn('Microphone start failed:',err);
      cleanupMic();
      var name = err && err.name ? err.name : '';
      if(name === 'NotAllowedError' || name === 'PermissionDeniedError'){
        setStatus('Mikrofon er blokeret · tillad mikrofon for siden i browserens adressefelt');
      }else if(name === 'NotFoundError'){
        setStatus('Ingen mikrofon fundet på computeren');
      }else{
        setStatus('Mikrofon kunne ikke startes · ' + (err && err.message ? err.message : 'ukendt fejl'));
      }
    }
  }

  async function stopMicAndSend(){
    if(!state.recording) return;
    state.recording = false;
    resetMicUi();
    setStatus('Behandler lyd lokalt…');

    var chunks = state.audioChunks.slice();
    var total = state.audioSamples;
    var inputRate = state.audioSampleRate || 48000;
    cleanupMic(false);

    if(!total || !chunks.length){
      setStatus('Der blev ikke optaget nogen lyd · prøv igen');
      return;
    }

    var merged = new Float32Array(total);
    var offset = 0;
    for(var i=0;i<chunks.length;i++){
      merged.set(chunks[i],offset);
      offset += chunks[i].length;
    }

    var duration = merged.length / inputRate;
    if(duration < 0.25){
      setStatus('Optagelsen var for kort · tal lidt længere og prøv igen');
      return;
    }

    try{
      el('trainerMic').disabled = true;
      el('trainerSend').disabled = true;
      el('trainerInput').disabled = true;
      setStatus('Transskriberer med lokal Whisper…');
      var audio16 = resampleAudio(merged,inputRate,16000);
      var transcriber = await ensureWhisper();
      var result = await transcriber(audio16,{
        language:'danish',
        task:'transcribe',
        chunk_length_s:30,
        stride_length_s:5
      });
      var text = String(result && result.text || '').trim();
      if(!text){
        setStatus('Whisper hørte ingen tydelig tale · prøv igen tættere på mikrofonen');
        return;
      }
      el('trainerInput').value = text;
      el('trainerVoiceStatus').textContent = 'Whisper: Klar · dansk';
      await submitEmployee(text);
    }catch(err){
      console.warn('Whisper transcription failed:',err);
      setStatus('Lokal Whisper kunne ikke transskribere · ' + (err && err.message ? err.message : 'ukendt fejl'));
      el('trainerVoiceStatus').textContent = 'Whisper: Fejl · tekst virker';
    }finally{
      if(state.active && !state.busy){
        el('trainerMic').disabled = false;
        el('trainerSend').disabled = false;
        el('trainerInput').disabled = false;
      }
    }
  }

  async function ensureWhisper(){
    if(state.transcriber) return state.transcriber;
    if(state.transcriberPromise) return state.transcriberPromise;

    state.transcriberPromise = (async function(){
      showProgress(true);
      el('trainerProgressText').textContent = 'Henter lokal Whisper-model første gang…';
      el('trainerProgressPct').textContent = '';
      el('trainerProgressBar').style.width = '8%';
      el('trainerVoiceStatus').textContent = 'Whisper: Indlæser…';

      try{
        var hf = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm');
        hf.env.remoteHost = window.location.origin + '/hf/';
        hf.env.remotePathTemplate = '{model}/resolve/{revision}/{file}';
        hf.env.allowRemoteModels = true;
        hf.env.useBrowserCache = true;
        var device = navigator.gpu ? 'webgpu' : 'wasm';
        state.transcriber = await hf.pipeline(
          'automatic-speech-recognition',
          WHISPER_MODEL,
          {
            device:device,
            progress_callback:function(info){
              var p = info && typeof info.progress === 'number' ? info.progress : null;
              if(p != null){
                var pct = Math.max(0,Math.min(100,Math.round(p)));
                el('trainerProgressPct').textContent = pct + '%';
                el('trainerProgressBar').style.width = pct + '%';
              }
              if(info && info.status){
                el('trainerProgressText').textContent = 'Whisper · ' + info.status;
              }
            }
          }
        );
        state.whisperReady = true;
        el('trainerVoiceStatus').textContent = 'Whisper: Klar · dansk';
        el('trainerProgressBar').style.width = '100%';
        el('trainerProgressPct').textContent = '100%';
        el('trainerProgressText').textContent = 'Whisper klar og cachet i browseren';
        setTimeout(function(){ showProgress(false); },900);
        return state.transcriber;
      }catch(err){
        state.transcriber = null;
        state.whisperReady = false;
        showProgress(false);
        throw err;
      }finally{
        state.transcriberPromise = null;
      }
    })();

    return state.transcriberPromise;
  }

  function resampleAudio(input,inputRate,targetRate){
    if(inputRate === targetRate) return input;
    var outLength = Math.max(1,Math.round(input.length * targetRate / inputRate));
    var output = new Float32Array(outLength);
    var ratio = inputRate / targetRate;
    for(var i=0;i<outLength;i++){
      var pos = i * ratio;
      var left = Math.floor(pos);
      var right = Math.min(input.length-1,left+1);
      var frac = pos-left;
      output[i] = input[left]*(1-frac) + input[right]*frac;
    }
    return output;
  }

  function cleanupMic(clearAudio){
    if(state.audioProcessor){
      try{ state.audioProcessor.onaudioprocess = null; state.audioProcessor.disconnect(); }catch(_){}
    }
    if(state.audioSource){ try{ state.audioSource.disconnect(); }catch(_){} }
    if(state.audioSink){ try{ state.audioSink.disconnect(); }catch(_){} }
    if(state.audioStream){
      try{ state.audioStream.getTracks().forEach(function(t){t.stop();}); }catch(_){}
    }
    if(state.audioContext){
      try{ state.audioContext.close(); }catch(_){}
    }
    state.audioStream = null;
    state.audioContext = null;
    state.audioSource = null;
    state.audioProcessor = null;
    state.audioSink = null;
    state.recording = false;
    if(clearAudio !== false){
      state.audioChunks = [];
      state.audioSamples = 0;
    }
    resetMicUi();
  }

  function resetMicUi(){
    var mic = el('trainerMic');
    if(!mic) return;
    mic.classList.remove('listening');
    mic.textContent = '🎙';
    mic.setAttribute('aria-label','Start lokal lydoptagelse');
    mic.title = 'Start lokal lydoptagelse';
  }

  function finishTraining(){
    if(!state.active) return;
    state.active = false;
    cleanupMic();
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
      if(state.recording){
        stopMicAndSend();
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
