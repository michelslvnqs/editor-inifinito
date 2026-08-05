export interface Env {
    editor_jobs: D1Database;
    editor_storage: R2Bucket;
    QUEUE_MANAGER: DurableObjectNamespace;
}

function extractYouTubeId(url: string): string | null {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        // Helper para avisar o Durable Object
        const notifyDO = async (payload: any) => {
            const id = env.QUEUE_MANAGER.idFromName("global_room");
            const stub = env.QUEUE_MANAGER.get(id);
            await stub.fetch(new Request("http://internal/broadcast", {
                method: "POST",
                body: JSON.stringify(payload)
            }));
        };

        // API: Conexão WebSocket Principal
        if (url.pathname === "/api/ws") {
            const id = env.QUEUE_MANAGER.idFromName("global_room");
            const stub = env.QUEUE_MANAGER.get(id);
            return stub.fetch(request);
        }

        // Frontend
        if (request.method === "GET" && url.pathname === "/") {
            return new Response(htmlInterface, {
                headers: { "Content-Type": "text/html;charset=UTF-8" },
            });
        }

        // API: Fetch YouTube Info (Subtitles)
        if (request.method === "GET" && url.pathname === "/api/info") {
            const ytUrl = url.searchParams.get("url");
            if (!ytUrl) return new Response("Missing url", { status: 400, headers: corsHeaders });
            try {
                const ytRes = await fetch(ytUrl, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7",
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
                    }
                });
                const html = await ytRes.text();
                const match = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
                let subs: any[] = [];
                if (match) {
                    const json = JSON.parse(match[1]);
                    const tracks = json.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
                    subs = tracks.map((t: any) => ({ code: t.languageCode, name: t.name.simpleText }));
                }
                return new Response(JSON.stringify({ subtitles: subs }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
            }
        }

        // API: Criar pedido de corte (Deduplicação Inteligente)
        if (request.method === "POST" && url.pathname === "/api/videos") {
            try {
                const body = await request.json() as any;
                const { youtube_url, start_ms = 0, end_ms = 0, subtitle_lang = null } = body;
                if (!youtube_url) return new Response(JSON.stringify({ error: "youtube_url is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
                
                const youtube_id = extractYouTubeId(youtube_url);
                if (!youtube_id) return new Response(JSON.stringify({ error: "URL do YouTube inválida" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

                const job_id = start_ms === -1 ? `${youtube_id}_info` : `${youtube_id}_${Math.floor(start_ms)}_${Math.floor(end_ms)}` + (subtitle_lang ? `_sub_${subtitle_lang}` : "");

                // Verifica se já existe o mesmo corte
                const row = await env.editor_jobs.prepare(
                    "SELECT * FROM cuts WHERE job_id = ?"
                ).bind(job_id).first();

                if (row) {
                    if (row.status === 'concluido') {
                        return new Response(JSON.stringify({
                            job_id,
                            status: row.status,
                            r2_url: `${url.origin}/downloads/${job_id}`
                        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                    }

                    // Se não estiver concluído, reseta para 'pendente' e notifica o operador novamente
                    await env.editor_jobs.prepare(
                        "UPDATE cuts SET status = 'pendente', error_msg = NULL WHERE job_id = ?"
                    ).bind(job_id).run();

                    ctx.waitUntil(notifyDO({ type: "new_job", job_id, youtube_id, start_ms, end_ms, subtitle_lang }));

                    return new Response(JSON.stringify({ job_id, status: "pendente" }), {
                        headers: { ...corsHeaders, "Content-Type": "application/json" },
                    });
                }

                // Novo pedido de corte
                await env.editor_jobs.prepare(
                    "INSERT INTO cuts (job_id, youtube_id, start_ms, end_ms, status, subtitle_lang) VALUES (?, ?, ?, ?, ?, ?)"
                ).bind(job_id, youtube_id, start_ms, end_ms, "pendente", subtitle_lang).run();

                ctx.waitUntil(notifyDO({ type: "new_job", job_id, youtube_id, start_ms, end_ms, subtitle_lang }));

                return new Response(JSON.stringify({ job_id, status: "pendente" }), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
            }
        }

        // API: Status do pedido de corte
        if (request.method === "GET" && url.pathname.startsWith("/api/videos/")) {
            const job_id = url.pathname.split("/").pop();
            if (!job_id) return new Response("Not found", { status: 404 });

            const row = await env.editor_jobs.prepare(
                "SELECT * FROM cuts WHERE job_id = ?"
            ).bind(job_id).first();

            if (!row) return new Response(JSON.stringify({ error: "Pedido não encontrado" }), { status: 404, headers: corsHeaders });

            return new Response(JSON.stringify({
                ...row,
                r2_url: row.status === 'concluido' ? `${url.origin}/downloads/${job_id}` : null
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // API (Python): Pegar próximo corte
        if (request.method === "GET" && url.pathname === "/api/queue/next") {
            const row = await env.editor_jobs.prepare(
                "SELECT * FROM cuts WHERE status = 'pendente' ORDER BY created_at ASC LIMIT 1"
            ).first();

            if (!row) {
                return new Response(JSON.stringify({ message: "Fila vazia" }), {
                    status: 404,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            }

            await env.editor_jobs.prepare(
                "UPDATE cuts SET status = 'processando' WHERE job_id = ?"
            ).bind(row.job_id).run();

            return new Response(JSON.stringify(row), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // API (Python): Upload para R2 do trecho cortado
        if (request.method === "PUT" && url.pathname.match(/^\/api\/queue\/[a-zA-Z0-9_.-]+\/upload$/)) {
            const job_id = url.pathname.split("/")[3];
            const ext = url.searchParams.get("ext") || "mp4";
            const filename = `${job_id}.${ext}`;
            
            await env.editor_storage.put(filename, request.body);
            
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        // API (Python): Marcar como concluído
        if (request.method === "POST" && url.pathname.match(/^\/api\/queue\/[a-zA-Z0-9_.-]+\/status$/)) {
            const job_id = url.pathname.split("/")[3];
            try {
                const { status, error_msg, title } = await request.json() as any;
                
                const updates = ["status = ?"];
                const params: any[] = [status];
                
                if (error_msg !== undefined) {
                    updates.push("error_msg = ?");
                    params.push(error_msg);
                }
                if (title !== undefined) {
                    updates.push("title = ?");
                    params.push(title);
                }
                
                params.push(job_id);
                
                await env.editor_jobs.prepare(
                    `UPDATE cuts SET ${updates.join(", ")} WHERE job_id = ?`
                ).bind(...params).run();

                ctx.waitUntil(notifyDO({ type: "status_update", job_id, status, error_msg, title }));

                return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
            }
        }

        // Download do R2
        if (request.method === "GET" && url.pathname.startsWith("/downloads/")) {
            const job_id = url.pathname.split("/").pop();
            if (!job_id) return new Response("Not found", { status: 404 });

            const row = await env.editor_jobs.prepare("SELECT title, start_ms, end_ms FROM cuts WHERE job_id = ?").bind(job_id).first();
            
            let originalTitle = job_id;
            if (row && row.title) {
                originalTitle = `${row.title}_cortado_${row.start_ms}_a_${row.end_ms}`;
            }

            const object = await env.editor_storage.get(`${job_id}.mp4`);
            if (!object) return new Response("File not found in R2", { status: 404 });

            const safeFilename = encodeURIComponent(originalTitle.replace(/[\/\\?%*:|"<>]/g, '')) + ".mp4";

            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set("etag", object.httpEtag);
            headers.set("Content-Disposition", `attachment; filename*=UTF-8''${safeFilename}`);

            return new Response(object.body, { headers });
        }

        return new Response("Not found", { status: 404 });
    }
};

const htmlInterface = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Infinity Cuts | Premium</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.7.1/nouislider.min.css">
    <style>
        :root {
            --primary: #ff3366;
            --secondary: #ff9933;
            --bg-color: #0d0d12;
            --glass-bg: rgba(255, 255, 255, 0.03);
            --glass-border: rgba(255, 255, 255, 0.08);
            --text-main: #f0f0f0;
            --text-muted: #888;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Outfit', sans-serif; }
        body {
            background-color: var(--bg-color);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px 0;
            background-image: radial-gradient(circle at 15% 50%, rgba(255, 51, 102, 0.15), transparent 25%),
                              radial-gradient(circle at 85% 30%, rgba(255, 153, 51, 0.15), transparent 25%);
        }
        .container {
            width: 90%;
            max-width: 500px;
            background: var(--glass-bg);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid var(--glass-border);
            border-radius: 24px;
            padding: 40px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            animation: slideUp 0.8s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes slideUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }
        h1 {
            font-size: 2.5rem;
            font-weight: 800;
            margin-bottom: 8px;
            text-align: center;
            background: linear-gradient(to right, var(--primary), var(--secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        p.subtitle {
            text-align: center;
            color: var(--text-muted);
            margin-bottom: 30px;
            font-size: 0.95rem;
        }
        .input-group {
            margin-bottom: 20px;
            position: relative;
        }
        .input-group label {
            display: block;
            font-size: 0.85rem;
            color: var(--text-muted);
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        input {
            width: 100%;
            background: rgba(0,0,0,0.4);
            border: 1px solid var(--glass-border);
            color: white;
            padding: 14px 16px;
            border-radius: 12px;
            font-size: 1rem;
            transition: all 0.3s ease;
            outline: none;
        }
        input:focus {
            border-color: var(--primary);
            box-shadow: 0 0 15px rgba(255, 51, 102, 0.2);
        }
        .time-row {
            display: flex;
            gap: 15px;
        }
        .time-row .input-group { flex: 1; }
        button {
            width: 100%;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            color: white;
            border: none;
            padding: 16px;
            border-radius: 12px;
            font-size: 1.1rem;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            margin-top: 10px;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(255, 51, 102, 0.3);
        }
        button:active { transform: translateY(0); }
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        
        /* Editor Timeline Styles */
        .noUi-target {
            background: rgba(255,255,255,0.1);
            border: none;
            border-radius: 8px;
            box-shadow: none;
            height: 8px;
        }
        .noUi-connect {
            background: linear-gradient(to right, var(--primary), var(--secondary));
        }
        .noUi-handle {
            border: 3px solid var(--primary);
            border-radius: 50%;
            background: #fff;
            box-shadow: 0 0 15px rgba(255, 51, 102, 0.6);
            width: 24px !important;
            height: 24px !important;
            right: -12px !important;
            top: -8px !important;
            cursor: pointer;
            transition: transform 0.2s;
        }
        .noUi-handle:before, .noUi-handle:after { display: none; }
        .noUi-handle:hover {
            transform: scale(1.15);
        }
        
        #btn-testar {
            background: rgba(255, 51, 102, 0.15);
            color: var(--primary);
            border: 1px solid var(--primary);
            margin-top: 0;
            padding: 12px;
            font-size: 0.95rem;
        }
        #btn-testar:hover { background: rgba(255, 51, 102, 0.25); }
        
        #btn-pausar {
            background: rgba(255, 255, 255, 0.1);
            color: white;
            border: 1px solid var(--glass-border);
            margin-top: 0;
            padding: 12px;
            font-size: 0.95rem;
            display: none;
        }
        #btn-pausar:hover { background: rgba(255, 255, 255, 0.2); }

        /* Status Area */
        #status-area {
            margin-top: 30px;
            display: none;
            text-align: center;
            animation: fadeIn 0.5s;
        }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .progress-pill {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            background: rgba(255, 51, 102, 0.1);
            border: 1px solid var(--primary);
            padding: 8px 16px;
            border-radius: 30px;
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--primary);
        }
        .spinner {
            width: 16px;
            height: 16px;
            border: 2px solid var(--primary);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .download-btn {
            background: #00c853;
            margin-top: 15px;
            text-decoration: none;
            display: block;
            padding: 16px;
            border-radius: 12px;
            color: white;
            font-weight: 600;
            box-shadow: 0 10px 20px rgba(0, 200, 83, 0.3);
            transition: all 0.3s;
        }
        .download-btn.disabled {
            background: rgba(255, 255, 255, 0.1);
            color: var(--text-muted);
            pointer-events: none;
            box-shadow: none;
        }
        .download-btn:hover {
            background: #00e676;
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(0, 200, 83, 0.5);
        }
        .cancel-btn {
            background: transparent;
            border: 1px solid var(--glass-border);
            color: var(--text-muted);
            margin-top: 10px;
            padding: 12px;
            font-size: 0.9rem;
        }
        .cancel-btn:hover {
            border-color: rgba(255,255,255,0.3);
            color: white;
            box-shadow: none;
        }
        .badge-cache { font-size: 11px; background: #22c55e; color: white; padding: 2px 6px; border-radius: 4px; vertical-align: middle; margin-left: 5px; }
    </style>
</head>
<body>

<div class="container">
    <h1>Editor Infinito</h1>
    <p class="subtitle">Cortes perfeitos, sem limites e na velocidade da luz.</p>

    <div id="form-area">
        <div class="input-group">
            <label>Link do YouTube</label>
            <input type="text" id="url" placeholder="Cole o link aqui..." autocomplete="off">
        </div>
        
        <div id="editor-area" style="display:none; margin-top:10px; animation: fadeIn 0.5s;">
            <div id="player-wrapper" style="border-radius:12px; overflow:hidden; margin-bottom:25px; box-shadow: 0 15px 30px rgba(0,0,0,0.5); position: relative; padding-bottom: 56.25%; height: 0;">
                <div id="player" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></div>
            </div>
            
            <div class="input-group" id="subtitle-group" style="margin-bottom: 25px;">
                <label>Legenda (Hardsub)</label>
                <select id="subtitle-lang" style="width: 100%; padding: 12px; border-radius: 8px; background: rgba(0,0,0,0.5); border: 1px solid var(--glass-border); color: white; margin-top: 5px;">
                    <option value="">Sem legenda</option>
                </select>
            </div>
            
            <div class="input-group">
                <label style="margin-bottom: 15px;">Ajuste o Trecho</label>
                <div id="timeline" style="margin: 0 10px 25px 10px;"></div>
            </div>

            <div class="time-row">
                <div class="input-group">
                    <label>Início (Ex: 00:30:00 ou 1:30:30)</label>
                    <input type="text" id="inicio" placeholder="00:00:00" autocomplete="off">
                </div>
                <div class="input-group">
                    <label>Fim (Ex: 01:00:00 ou 1:45:50)</label>
                    <input type="text" id="fim" placeholder="00:30:00" autocomplete="off">
                </div>
            </div>
            
            <div style="display: flex; gap: 15px; margin-bottom: 20px;">
                <button id="btn-testar" type="button">▶ Testar Corte (Loop)</button>
                <button id="btn-pausar" type="button">⏸ Pausar Teste</button>
            </div>

            <button id="btn-cortar" onclick="iniciarCorte()">✂️ Cortar e Exportar</button>
            <a href="#" class="download-btn disabled" id="btn-download" style="display:block; text-align:center; cursor:default;" target="_blank">⬇️ Aguardando Corte...</a>
            
            <div id="status-area" style="display:none; text-align:center; margin-top:20px;">
                <div class="progress-pill" id="status-pill">
                    <div class="spinner" id="spinner"></div>
                    <span id="status-text">Processando...</span>
                </div>
            </div>
        </div>
    </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.7.1/nouislider.min.js"></script>
<script>
    let ws = null;
    let player;
    let videoDuration = 0;
    let slider = null;
    let loopInterval = null;
    let isTesting = false;
    let loadedUrl = '';
    window.currentInfoJobId = null;

    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(protocol + '//' + window.location.host + '/api/ws');
        
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'status_update') {
                    // Trata atualização de Corte
                    const currentJob = localStorage.getItem('currentJobId');
                    if (data.job_id === currentJob) {
                        const statusText = document.getElementById('status-text');
                        if (data.status === 'processando') statusText.innerText = 'Preparando...';
                        else if (data.status === 'baixando') statusText.innerText = 'Baixando vídeo base do YouTube...';
                        else if (data.status === 'cortando') statusText.innerText = 'FFMPEG Trabalhando no corte...';
                        else if (data.status === 'uploading') statusText.innerText = 'Enviando para a Nuvem...';
                        else if (data.status === 'concluido') {
                            const r2_url = window.location.origin + '/downloads/' + data.job_id;
                            marcarConcluido(r2_url, false);
                        }
                        else if (data.status === 'erro') marcarErro(data.error_msg);
                    }
                    
                    // Trata atualização de Legendas (Info Job)
                    if (data.job_id === window.currentInfoJobId) {
                        const subSelect = document.getElementById('subtitle-lang');
                        if (data.status === 'concluido') {
                            try {
                                const subs = JSON.parse(data.error_msg || "[]");
                                subSelect.innerHTML = '<option value="">Sem legenda</option>';
                                if (subs.length > 0) {
                                    subs.forEach(s => {
                                        const opt = document.createElement('option');
                                        opt.value = s.code;
                                        opt.innerText = s.name;
                                        subSelect.appendChild(opt);
                                    });
                                } else {
                                    subSelect.innerHTML = '<option value="">Nenhuma legenda encontrada</option>';
                                }
                            } catch(e) {
                                subSelect.innerHTML = '<option value="">Nenhuma legenda encontrada</option>';
                            }
                        } else if (data.status === 'erro') {
                            subSelect.innerHTML = '<option value="">Erro ao buscar legendas</option>';
                        }
                    }
                }
            } catch (e) {
                console.error(e);
            }
        };
        
        ws.onclose = () => {
            setTimeout(connectWebSocket, 2000); // Reconnect
        };
    }

    // Inicializa a API do YouTube e WebSocket
    var tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    var firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    window.onload = () => {
        connectWebSocket();
        const jobId = localStorage.getItem('currentJobId');
        if (jobId) {
            // Se houver um job pendente, mostramos o status.
            // Como usamos WebSocket, assim que o servidor mandar o status, atualiza sozinho!
            mostrarStatus();
        }
    };

    // Detecta colagem de link do YouTube
    document.getElementById('url').addEventListener('input', async function(e) {
        const val = e.target.value;
        const match = val.match(/(?:youtu\\.be\\/|youtube\\.com\\/(?:.*v=|.*\\/))([^&?]+)/);
        if(match && match[1]) {
            loadedUrl = val;
            loadVideo(match[1]);
            
            const subSelect = document.getElementById('subtitle-lang');
            subSelect.innerHTML = '<option value="">Carregando legendas (Operador via WebSocket)...</option>';
            try {
                const res = await fetch('/api/videos', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ youtube_url: val, start_ms: -1, end_ms: -1 })
                });
                const data = await res.json();
                
                if (data.job_id) {
                    window.currentInfoJobId = data.job_id;
                    if (data.status === 'concluido') {
                        // Já estava no cache
                        ws.onmessage({ data: JSON.stringify({ type: 'status_update', job_id: data.job_id, status: 'concluido', error_msg: data.error_msg }) });
                    }
                }
            } catch(err) {
                subSelect.innerHTML = '<option value="">Erro de conexão</option>';
            }
        } else {
            document.getElementById('editor-area').style.display = 'none';
            if(player && player.destroy) player.destroy();
            player = null;
        }
    });

    function loadVideo(videoId) {
        document.getElementById('editor-area').style.display = 'block';
        if(player && player.destroy) {
            player.destroy();
            player = null;
        }
        
        player = new YT.Player('player', {
            videoId: videoId,
            playerVars: {
                'playsinline': 1,
                'controls': 1,
                'rel': 0,
                'modestbranding': 1
            },
            events: {
                'onReady': onPlayerReady
            }
        });
    }

    function onPlayerReady(event) {
        videoDuration = player.getDuration();
        initSlider();
    }

    function initSlider() {
        const timeline = document.getElementById('timeline');
        if(slider) {
            slider.destroy();
        }
        
        const start = 0;
        const end = Math.min(30, videoDuration);

        slider = noUiSlider.create(timeline, {
            start: [start, end],
            connect: true,
            range: {
                'min': 0,
                'max': videoDuration
            }
        });

        slider.on('update', function(values, handle) {
            const val = parseFloat(values[handle]);
            const formatted = formatTime(val);
            if(handle === 0) {
                document.getElementById('inicio').value = formatted;
            } else {
                document.getElementById('fim').value = formatted;
            }
        });

        document.getElementById('inicio').addEventListener('change', function(e) {
            slider.set([parseTime(e.target.value), null]);
        });
        document.getElementById('fim').addEventListener('change', function(e) {
            slider.set([null, parseTime(e.target.value)]);
        });
    }

    function formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.round((seconds % 1) * 1000);
        const cs = Math.floor((ms % 1000) / 10);

        const csStr = cs.toString().padStart(2, '0');
        const sStr = s.toString().padStart(2, '0');
        const mStr = m.toString().padStart(2, '0');
        const hStr = h.toString().padStart(2, '0');

        if(h > 0) return \`\${hStr}:\${mStr}:\${sStr}:\${csStr}\`;
        return \`\${mStr}:\${sStr}:\${csStr}\`;
    }

    function parseMsString(msStr) {
        if (!msStr) return 0;
        if (msStr.length === 1) return parseInt(msStr, 10) / 10;
        if (msStr.length === 2) return parseInt(msStr, 10) / 100;
        return parseInt(msStr.slice(0, 3), 10) / 1000;
    }

    function parseTime(str) {
        if (!str) return 0;
        str = str.trim().replace(',', '.');
        let ms = 0;
        let mainStr = str;

        if (mainStr.includes('.')) {
            const parts = mainStr.split('.');
            mainStr = parts[0];
            ms = parseFloat('0.' + (parts[1] || '0'));
        }

        const pts = mainStr.split(':').map(p => parseInt(p, 10) || 0);

        if (!str.includes('.')) {
            if (pts.length === 4) {
                const msStr = str.split(':')[3];
                ms = parseMsString(msStr);
                return pts[0] * 3600 + pts[1] * 60 + pts[2] + ms;
            } else if (pts.length === 3) {
                const msStr = str.split(':')[2];
                const isMs = msStr.length === 3 || pts[2] > 59 || (typeof videoDuration !== 'undefined' && videoDuration > 0 && videoDuration < 3600);
                if (isMs) {
                    ms = parseMsString(msStr);
                    return pts[0] * 60 + pts[1] + ms;
                } else {
                    return pts[0] * 3600 + pts[1] * 60 + pts[2];
                }
            } else if (pts.length === 2) {
                return pts[0] * 60 + pts[1];
            } else if (pts.length === 1) {
                return pts[0];
            }
        }

        if (pts.length === 3) return pts[0] * 3600 + pts[1] * 60 + pts[2] + ms;
        if (pts.length === 2) return pts[0] * 60 + pts[1] + ms;
        if (pts.length === 1) return pts[0] + ms;
        return 0;
    }

    // Controles de Teste (Loop)
    document.getElementById('btn-testar').addEventListener('click', function() {
        if(!player || !slider) return;
        const vals = slider.get();
        const start = parseFloat(vals[0]);
        const end = parseFloat(vals[1]);
        
        if (start >= end) return alert('Tempo inicial deve ser menor que o final!');

        isTesting = true;
        document.getElementById('btn-testar').style.display = 'none';
        document.getElementById('btn-pausar').style.display = 'block';
        
        player.seekTo(start, true);
        player.playVideo();
        
        if(loopInterval) clearInterval(loopInterval);
        loopInterval = setInterval(() => {
            const current = player.getCurrentTime();
            if(current >= end || current < start) {
                player.seekTo(start, true);
            }
        }, 100);
    });

    document.getElementById('btn-pausar').addEventListener('click', function() {
        isTesting = false;
        document.getElementById('btn-testar').style.display = 'block';
        document.getElementById('btn-pausar').style.display = 'none';
        
        if(loopInterval) clearInterval(loopInterval);
        player.pauseVideo();
    });

    async function iniciarCorte() {
        const url = loadedUrl;
        const inicio = document.getElementById('inicio').value;
        const fim = document.getElementById('fim').value;

        if (!url || !inicio || !fim) {
            alert('Preencha todos os campos!');
            return;
        }

        const startS = parseTime(inicio);
        const endS = parseTime(fim);

        const subtitle_lang = document.getElementById('subtitle-lang').value || null;

        if (startS >= endS) {
            alert('O tempo de início deve ser menor que o tempo de fim.');
            return;
        }

        const btn = document.getElementById('btn-cortar');
        btn.disabled = true;
        btn.innerText = 'Enviando para o Operador via WebSocket...';
        
        const btnDownload = document.getElementById('btn-download');
        btnDownload.classList.add('disabled');
        btnDownload.innerText = '⬇️ Aguardando Corte...';
        btnDownload.href = '#';
        
        if(loopInterval) clearInterval(loopInterval);
        if(player && player.pauseVideo) player.pauseVideo();
        document.getElementById('btn-testar').style.display = 'block';
        document.getElementById('btn-pausar').style.display = 'none';

        try {
            const res = await fetch('/api/videos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    youtube_url: url, 
                    start_ms: startS * 1000, 
                    end_ms: endS * 1000,
                    subtitle_lang: subtitle_lang
                })
            });
            const data = await res.json();
            
            if (data.job_id) {
                localStorage.setItem('currentJobId', data.job_id);
                mostrarStatus();
                
                if (data.status === 'concluido') {
                    // CENA DO CACHE!
                    marcarConcluido(data.r2_url, true);
                }
            } else {
                alert('Erro ao criar pedido: ' + data.error);
                btn.disabled = false;
                btn.innerText = '✂️ Cortar e Exportar';
            }
        } catch (e) {
            alert('Erro de conexão.');
            btn.disabled = false;
            btn.innerText = '✂️ Cortar e Exportar';
        }
    }

    function mostrarStatus() {
        document.getElementById('status-area').style.display = 'block';
        const spinner = document.getElementById('spinner');
        spinner.style.display = 'inline-block';
        const btnCortar = document.getElementById('btn-cortar');
        btnCortar.disabled = true;
        
        const pill = document.getElementById('status-pill');
        pill.style.borderColor = 'var(--primary)';
        pill.style.background = 'rgba(255, 51, 102, 0.1)';
        document.getElementById('status-text').style.color = 'var(--primary)';
    }

    function marcarConcluido(r2_url, isCache) {
        const spinner = document.getElementById('spinner');
        const btnDownload = document.getElementById('btn-download');
        const pill = document.getElementById('status-pill');
        const statusText = document.getElementById('status-text');

        spinner.style.display = 'none';
        btnDownload.classList.remove('disabled');
        btnDownload.innerText = '⬇️ Baixar Corte (MP4)';
        
        const btnCortar = document.getElementById('btn-cortar');
        btnCortar.disabled = false;
        btnCortar.innerText = '✂️ Cortar e Exportar';
        
        pill.style.borderColor = '#00c853';
        pill.style.background = 'rgba(0, 200, 83, 0.1)';
        statusText.style.color = '#00c853';
        
        if (isCache) {
            statusText.innerHTML = 'Corte Encontrado! <span class="badge-cache">CACHE</span>';
        } else {
            statusText.innerText = '✅ Arquivo Cortado com Sucesso!';
        }
        
        btnDownload.href = r2_url;
    }

    function marcarErro(erroMsg) {
        const spinner = document.getElementById('spinner');
        const pill = document.getElementById('status-pill');
        const statusText = document.getElementById('status-text');

        spinner.style.display = 'none';
        statusText.style.color = '#ff5252';
        pill.style.borderColor = '#ff5252';
        pill.style.background = 'rgba(255,82,82,0.1)';
        statusText.innerText = '❌ Falha: ' + (erroMsg || 'Erro no processamento');
        
        const btnCortar = document.getElementById('btn-cortar');
        btnCortar.disabled = false;
        btnCortar.innerText = '✂️ Tentar Novamente';
    }
    
    function limparSessao() {
        localStorage.removeItem('currentJobId');
        document.getElementById('form-area').style.display = 'block';
        document.getElementById('status-area').style.display = 'none';
        
        document.getElementById('btn-cortar').disabled = false;
        document.getElementById('btn-cortar').innerText = '✂️ Cortar e Exportar';
        
        document.getElementById('btn-download').style.display = 'none';
        document.getElementById('spinner').style.display = 'block';
        
        const pill = document.getElementById('status-pill');
        pill.style.borderColor = 'var(--primary)';
        pill.style.background = 'rgba(255, 51, 102, 0.1)';
        document.getElementById('status-text').style.color = 'var(--primary)';
        document.getElementById('status-text').innerText = 'Processando...';
    }
</script>
</body>
</html>
`;

export class QueueManager {
    state: DurableObjectState;

    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
    }

    async fetch(request: Request) {
        if (request.url.includes("/broadcast")) {
            const msg = await request.text();
            for (const ws of this.state.getWebSockets()) {
                ws.send(msg);
            }
            return new Response("OK");
        }

        if (request.headers.get("Upgrade") === "websocket") {
            const pair = new WebSocketPair();
            this.state.acceptWebSocket(pair[1]);
            return new Response(null, { status: 101, webSocket: pair[0] });
        }

        return new Response("Not found", { status: 404 });
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        for (const client of this.state.getWebSockets()) {
            if (client !== ws) client.send(message);
        }
    }
}
