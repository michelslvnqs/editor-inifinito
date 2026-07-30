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

        // API: Criar pedido (Deduplicação Inteligente)
        if (request.method === "POST" && url.pathname === "/api/videos") {
            try {
                const { youtube_url } = await request.json() as any;
                if (!youtube_url) return new Response(JSON.stringify({ error: "youtube_url is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
                
                const youtube_id = extractYouTubeId(youtube_url);
                if (!youtube_id) return new Response(JSON.stringify({ error: "URL do YouTube inválida" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

                // Verifica se já existe
                const row = await env.editor_jobs.prepare(
                    "SELECT * FROM videos WHERE youtube_id = ?"
                ).bind(youtube_id).first();

                if (row) {
                    // Já está na fila ou concluído, retorna o status atual
                    return new Response(JSON.stringify({
                        youtube_id,
                        status: row.status,
                        r2_url: row.status === 'concluido' ? `${url.origin}/downloads/${youtube_id}` : null
                    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
                }

                // Novo pedido
                await env.editor_jobs.prepare(
                    "INSERT INTO videos (youtube_id, status) VALUES (?, ?)"
                ).bind(youtube_id, "pendente").run();

                return new Response(JSON.stringify({ youtube_id, status: "pendente" }), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
            }
        }

        // API: Status do pedido
        if (request.method === "GET" && url.pathname.startsWith("/api/videos/")) {
            const youtube_id = url.pathname.split("/").pop();
            if (!youtube_id) return new Response("Not found", { status: 404 });

            const row = await env.editor_jobs.prepare(
                "SELECT * FROM videos WHERE youtube_id = ?"
            ).bind(youtube_id).first();

            if (!row) return new Response(JSON.stringify({ error: "Pedido não encontrado" }), { status: 404, headers: corsHeaders });

            return new Response(JSON.stringify({
                ...row,
                r2_url: row.status === 'concluido' ? `${url.origin}/downloads/${youtube_id}` : null
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // API (Python): Pegar próximo
        if (request.method === "GET" && url.pathname === "/api/queue/next") {
            const row = await env.editor_jobs.prepare(
                "SELECT * FROM videos WHERE status = 'pendente' ORDER BY created_at ASC LIMIT 1"
            ).first();

            if (!row) {
                return new Response(JSON.stringify({ message: "Fila vazia" }), {
                    status: 404,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            }

            await env.editor_jobs.prepare(
                "UPDATE videos SET status = 'processando' WHERE youtube_id = ?"
            ).bind(row.youtube_id).run();

            return new Response(JSON.stringify(row), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // API (Python): Upload para R2
        if (request.method === "PUT" && url.pathname.match(/^\/api\/queue\/[a-zA-Z0-9_-]+\/upload$/)) {
            const youtube_id = url.pathname.split("/")[3];
            const ext = url.searchParams.get("ext") || "mp4";
            const filename = `${youtube_id}.${ext}`;
            
            await env.editor_storage.put(filename, request.body);
            
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        // API (Python): Marcar como concluído ou erro (Recebe o title)
        if (request.method === "POST" && url.pathname.match(/^\/api\/queue\/[a-zA-Z0-9_-]+\/complete$/)) {
            const youtube_id = url.pathname.split("/")[3];
            try {
                const { status, error_msg, title } = await request.json() as any;
                
                await env.editor_jobs.prepare(
                    "UPDATE videos SET status = ?, error_msg = ?, title = ? WHERE youtube_id = ?"
                ).bind(status, error_msg || null, title || null, youtube_id).run();

                return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
            }
        }

        // Download do arquivo do R2 com o nome original (Content-Disposition)
        if (request.method === "GET" && url.pathname.startsWith("/downloads/")) {
            const youtube_id = url.pathname.split("/").pop();
            if (!youtube_id) return new Response("Not found", { status: 404 });

            // Buscar informações no D1 para obter o título original
            const row = await env.editor_jobs.prepare("SELECT title FROM videos WHERE youtube_id = ?").bind(youtube_id).first();
            const originalTitle = row && row.title ? String(row.title) : youtube_id;

            // Busca o arquivo, tentaremos com mp4 como fallback (pois é o mais comum)
            // Se você puder ter webm, mkvs, pode precisar armazenar a extensão no D1 também. 
            // Para simplificar, assumimos mp4.
            const object = await env.editor_storage.get(`${youtube_id}.mp4`);
            if (!object) return new Response("File not found in R2", { status: 404 });

            const safeFilename = encodeURIComponent(originalTitle.replace(/[\/\\?%*:|"<>]/g, '')) + ".mp4";

            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set("etag", object.httpEtag);
            // Isso força o download com o nome original elegante!
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
    <title>Editor Infinito - Downloader</title>
    <style>
        body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { background: #1e293b; padding: 2rem; border-radius: 12px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); text-align: center; max-width: 400px; width: 100%; }
        input { width: calc(100% - 22px); padding: 10px; margin-bottom: 10px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: white; }
        button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; width: 100%; }
        button:hover { background: #2563eb; }
        #status-box { margin-top: 20px; padding: 15px; border-radius: 6px; display: none; background: #334155; border: 1px solid #475569; }
        .spinner { animation: spin 1s linear infinite; display: inline-block; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        a.btn-download { display: inline-block; background: #10b981; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 10px;}
        a.btn-download:hover { background: #059669; }
        .error { color: #ef4444; }
        .badge-cache { font-size: 11px; background: #22c55e; padding: 2px 6px; border-radius: 4px; vertical-align: middle; margin-left: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Baixar Vídeo</h2>
        <input type="text" id="url" placeholder="https://youtube.com/watch?v=..." />
        <button onclick="enviar()">Colocar na Fila</button>
        
        <div id="status-box">
            <div id="status-text">Processando...</div>
            <div id="link-box"></div>
        </div>
    </div>

    <script>
        let currentId = null;
        let pollInterval = null;

        async function enviar() {
            const url = document.getElementById('url').value;
            if (!url) return alert('Insira uma URL válida');

            document.getElementById('status-box').style.display = 'block';
            document.getElementById('status-text').innerHTML = 'Analisando URL... <span class="spinner">⏳</span>';
            document.getElementById('link-box').innerHTML = '';
            clearInterval(pollInterval);

            try {
                const res = await fetch('/api/videos', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ youtube_url: url })
                });
                const data = await res.json();
                
                if (data.youtube_id) {
                    currentId = data.youtube_id;
                    if (data.status === 'concluido') {
                        // Magia do Cache!
                        document.getElementById('status-text').innerHTML = '✅ Vídeo Encontrado! <span class="badge-cache">CACHE</span>';
                        document.getElementById('link-box').innerHTML = \`<a href="\${data.r2_url}" class="btn-download">⬇️ Baixar Arquivo Original</a>\`;
                    } else {
                        document.getElementById('status-text').innerHTML = 'Na fila, aguardando... <span class="spinner">⏳</span>';
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
            if (!currentId) return;
            const res = await fetch('/api/videos/' + currentId);
            const data = await res.json();

            if (data.status === 'processando') {
                document.getElementById('status-text').innerHTML = 'Operador trabalhando... <span class="spinner">⚙️</span>';
            } else if (data.status === 'concluido') {
                clearInterval(pollInterval);
                document.getElementById('status-text').innerHTML = '✅ Download Pronto!';
                document.getElementById('link-box').innerHTML = \`<a href="\${data.r2_url}" class="btn-download">⬇️ Baixar Arquivo Original</a>\`;
            } else if (data.status === 'erro') {
                clearInterval(pollInterval);
                document.getElementById('status-text').innerHTML = '<span class="error">❌ Falha: ' + (data.error_msg || 'Erro desconhecido') + '</span>';
            }
        }
    </script>
</body>
</html>
`;
