export interface Env {
    editor_jobs: D1Database;
    editor_storage: R2Bucket;
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

        // Frontend
        if (request.method === "GET" && url.pathname === "/") {
            return new Response(htmlInterface, {
                headers: { "Content-Type": "text/html;charset=UTF-8" },
            });
        }

        // API: Criar pedido de corte (Deduplicação Inteligente)
        if (request.method === "POST" && url.pathname === "/api/videos") {
            try {
                const body = await request.json() as any;
                const { youtube_url, start_ms = 0, end_ms = 0 } = body;
                if (!youtube_url) return new Response(JSON.stringify({ error: "youtube_url is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
                
                const youtube_id = extractYouTubeId(youtube_url);
                if (!youtube_id) return new Response(JSON.stringify({ error: "URL do YouTube inválida" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

                const job_id = `${youtube_id}_${Math.floor(start_ms)}_${Math.floor(end_ms)}`;

                // Verifica se já existe o mesmo corte
                const row = await env.editor_jobs.prepare(
                    "SELECT * FROM cuts WHERE job_id = ?"
                ).bind(job_id).first();

                if (row) {
                    return new Response(JSON.stringify({
                        job_id,
                        status: row.status,
                        r2_url: row.status === 'concluido' ? `${url.origin}/downloads/${job_id}` : null
                    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                }

                // Novo pedido de corte
                await env.editor_jobs.prepare(
                    "INSERT INTO cuts (job_id, youtube_id, start_ms, end_ms, status) VALUES (?, ?, ?, ?, ?)"
                ).bind(job_id, youtube_id, start_ms, end_ms, "pendente").run();

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
    <title>Editor Infinito - Editor de Cortes</title>
    <style>
        body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; min-height: 100vh; margin: 0; padding: 20px;}
        .container { background: #1e293b; padding: 2rem; border-radius: 12px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); width: 100%; max-width: 600px; margin-bottom: 20px;}
        h2 { margin-top: 0; text-align: center; }
        input[type="text"] { width: calc(100% - 22px); padding: 10px; margin-bottom: 10px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: white; }
        button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; width: 100%; margin-bottom: 10px;}
        button:hover { background: #2563eb; }
        .controls-row { display: flex; gap: 10px; margin-bottom: 15px;}
        .controls-row div { flex: 1; }
        .controls-row label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 5px; }
        .controls-row input { width: calc(100% - 22px); padding: 8px; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: white; }
        
        #player-container { width: 100%; aspect-ratio: 16/9; background: #000; display: none; margin-bottom: 15px; border-radius: 8px; overflow: hidden;}
        #editor-panel { display: none; margin-top: 15px; border-top: 1px solid #334155; padding-top: 15px;}
        
        #status-box { margin-top: 20px; padding: 15px; border-radius: 6px; display: none; background: #334155; border: 1px solid #475569; text-align: center; }
        .spinner { animation: spin 1s linear infinite; display: inline-block; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        a.btn-download { display: inline-block; background: #10b981; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 10px;}
        a.btn-download:hover { background: #059669; }
        .error { color: #ef4444; }
        .badge-cache { font-size: 11px; background: #22c55e; padding: 2px 6px; border-radius: 4px; vertical-align: middle; margin-left: 5px; }
        .btn-play-loop { background: #8b5cf6; }
        .btn-play-loop:hover { background: #7c3aed; }
    </style>
    <script src="https://www.youtube.com/iframe_api"></script>
</head>
<body>
    <div class="container">
        <h2>✂️ Editor de Cortes</h2>
        <input type="text" id="url" placeholder="https://youtube.com/watch?v=..." />
        <button onclick="carregarVideo()">Carregar Vídeo</button>
        
        <div id="player-container">
            <div id="ytplayer"></div>
        </div>

        <div id="editor-panel">
            <div class="controls-row">
                <div>
                    <label>Início (segundos)</label>
                    <input type="number" id="start-sec" value="0" step="0.1" min="0">
                </div>
                <div>
                    <label>Fim (segundos)</label>
                    <input type="number" id="end-sec" value="0" step="0.1" min="0">
                </div>
            </div>
            
            <button class="btn-play-loop" id="btn-loop" onclick="toggleLoop()">▶️ Testar Corte (Loop)</button>
            <button onclick="enviarParaFila()">✅ Colocar na Fila (Cortar e Baixar)</button>
        </div>
        
        <div id="status-box">
            <div id="status-text"></div>
            <div id="link-box"></div>
        </div>
    </div>

    <script>
        let player = null;
        let isLooping = false;
        let loopInterval = null;
        let currentJobId = null;
        let pollInterval = null;
        let videoDuration = 0;
        let loadedUrl = '';

        function extractYouTubeId(url) {
            const regExp = /^.*(youtu.be\\/|v\\/|u\\/\\w\\/|embed\\/|watch\\?v=|\\&v=)([^#\\&\\?]*).*/;
            const match = url.match(regExp);
            return (match && match[2].length === 11) ? match[2] : null;
        }

        // Carrega o Player do YT
        function carregarVideo() {
            const url = document.getElementById('url').value;
            const ytid = extractYouTubeId(url);
            if (!ytid) return alert('Insira uma URL do YouTube válida!');
            
            loadedUrl = url;
            document.getElementById('player-container').style.display = 'block';
            
            if (player) {
                player.loadVideoById(ytid);
                initEditor();
            } else {
                player = new YT.Player('ytplayer', {
                    height: '100%',
                    width: '100%',
                    videoId: ytid,
                    events: {
                        'onReady': onPlayerReady
                    }
                });
            }
        }

        function onPlayerReady(event) {
            initEditor();
        }

        function initEditor() {
            document.getElementById('editor-panel').style.display = 'block';
            setTimeout(() => {
                videoDuration = player.getDuration();
                if(videoDuration > 0) {
                    document.getElementById('end-sec').value = videoDuration;
                }
            }, 1000); // Aguarda um segundo para o YT fornecer a duração correta
        }

        function toggleLoop() {
            if (isLooping) {
                isLooping = false;
                clearInterval(loopInterval);
                document.getElementById('btn-loop').innerHTML = '▶️ Testar Corte (Loop)';
                player.pauseVideo();
            } else {
                let startS = parseFloat(document.getElementById('start-sec').value) || 0;
                let endS = parseFloat(document.getElementById('end-sec').value) || videoDuration;
                
                if (startS >= endS) return alert('O tempo inicial deve ser menor que o final!');

                isLooping = true;
                document.getElementById('btn-loop').innerHTML = '⏹️ Parar Loop';
                
                player.seekTo(startS, true);
                player.playVideo();

                loopInterval = setInterval(() => {
                    let current = player.getCurrentTime();
                    if (current >= endS || current < startS) {
                        player.seekTo(startS, true);
                    }
                }, 100);
            }
        }

        async function enviarParaFila() {
            let startS = parseFloat(document.getElementById('start-sec').value) || 0;
            let endS = parseFloat(document.getElementById('end-sec').value) || videoDuration;

            if (startS >= endS) return alert('Tempos inválidos.');

            document.getElementById('status-box').style.display = 'block';
            document.getElementById('status-text').innerHTML = 'Enviando para o operador... <span class="spinner">⏳</span>';
            document.getElementById('link-box').innerHTML = '';
            clearInterval(pollInterval);

            // Se o loop estiver ativo, paramos
            if (isLooping) toggleLoop();

            try {
                const res = await fetch('/api/videos', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        youtube_url: loadedUrl,
                        start_ms: startS * 1000,
                        end_ms: endS * 1000
                    })
                });
                const data = await res.json();
                
                if (data.job_id) {
                    currentJobId = data.job_id;
                    if (data.status === 'concluido') {
                        document.getElementById('status-text').innerHTML = '✅ Corte Encontrado! <span class="badge-cache">CACHE</span>';
                        document.getElementById('link-box').innerHTML = \`<a href="\${data.r2_url}" class="btn-download">⬇️ Baixar Corte (MP4)</a>\`;
                    } else {
                        document.getElementById('status-text').innerHTML = 'Na fila de processamento... <span class="spinner">⏳</span>';
                        pollInterval = setInterval(checkStatus, 5000);
                    }
                } else {
                    document.getElementById('status-text').innerHTML = \`<span class="error">\${data.error || 'Erro'}</span>\`;
                }
            } catch(e) {
                document.getElementById('status-text').innerHTML = '<span class="error">Erro de conexão.</span>';
            }
        }

        async function checkStatus() {
            if (!currentJobId) return;
            const res = await fetch('/api/videos/' + currentJobId);
            const data = await res.json();

            if (data.status === 'processando') {
                document.getElementById('status-text').innerHTML = 'Preparando... <span class="spinner">⚙️</span>';
            } else if (data.status === 'baixando') {
                document.getElementById('status-text').innerHTML = 'Baixando vídeo base do YouTube... <span class="spinner">⬇️</span>';
            } else if (data.status === 'cortando') {
                document.getElementById('status-text').innerHTML = 'FFMPEG Trabalhando no corte... <span class="spinner">✂️</span>';
            } else if (data.status === 'uploading') {
                document.getElementById('status-text').innerHTML = 'Enviando para a Nuvem... <span class="spinner">☁️</span>';
            } else if (data.status === 'concluido') {
                clearInterval(pollInterval);
                document.getElementById('status-text').innerHTML = '✅ Arquivo Cortado com Sucesso!';
                document.getElementById('link-box').innerHTML = \`<a href="\${data.r2_url}" class="btn-download">⬇️ Baixar Corte (MP4)</a>\`;
            } else if (data.status === 'erro') {
                clearInterval(pollInterval);
                document.getElementById('status-text').innerHTML = '<span class="error">❌ Falha: ' + (data.error_msg || 'Erro no processamento') + '</span>';
            }
        }
    </script>
</body>
</html>
`;
