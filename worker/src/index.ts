export interface Env {
    editor_jobs: D1Database;
    editor_storage: R2Bucket;
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

        // API: Criar pedido
        if (request.method === "POST" && url.pathname === "/api/pedidos") {
            try {
                const { youtube_url } = await request.json() as any;
                if (!youtube_url) return new Response(JSON.stringify({ error: "youtube_url is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
                
                const uid = crypto.randomUUID();
                
                await env.editor_jobs.prepare(
                    "INSERT INTO pedidos (uid, youtube_url, status) VALUES (?, ?, ?)"
                ).bind(uid, youtube_url, "pendente").run();

                return new Response(JSON.stringify({ uid, status: "pendente" }), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
            }
        }

        // API: Status do pedido
        if (request.method === "GET" && url.pathname.startsWith("/api/pedidos/")) {
            const uid = url.pathname.split("/").pop();
            if (!uid) return new Response("Not found", { status: 404 });

            const row = await env.editor_jobs.prepare(
                "SELECT * FROM pedidos WHERE uid = ?"
            ).bind(uid).first();

            if (!row) return new Response(JSON.stringify({ error: "Pedido não encontrado" }), { status: 404, headers: corsHeaders });

            return new Response(JSON.stringify(row), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // API (Python): Pegar próximo
        if (request.method === "GET" && url.pathname === "/api/queue/next") {
            const row = await env.editor_jobs.prepare(
                "SELECT * FROM pedidos WHERE status = 'pendente' ORDER BY created_at ASC LIMIT 1"
            ).first();

            if (!row) {
                return new Response(JSON.stringify({ message: "Fila vazia" }), {
                    status: 404,
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            }

            await env.editor_jobs.prepare(
                "UPDATE pedidos SET status = 'processando' WHERE uid = ?"
            ).bind(row.uid).run();

            return new Response(JSON.stringify(row), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        // API (Python): Upload para R2
        if (request.method === "PUT" && url.pathname.match(/^\/api\/queue\/[a-zA-Z0-9-]+\/upload$/)) {
            const uid = url.pathname.split("/")[3];
            const ext = url.searchParams.get("ext") || "mp4";
            const filename = `${uid}.${ext}`;
            
            await env.editor_storage.put(filename, request.body);
            
            return new Response(JSON.stringify({ 
                success: true, 
                r2_path: filename,
                download_url: `${url.origin}/downloads/${filename}`
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // API (Python): Marcar como concluído ou erro
        if (request.method === "POST" && url.pathname.match(/^\/api\/queue\/[a-zA-Z0-9-]+\/complete$/)) {
            const uid = url.pathname.split("/")[3];
            try {
                const { status, r2_url, error_msg } = await request.json() as any;
                
                await env.editor_jobs.prepare(
                    "UPDATE pedidos SET status = ?, r2_url = ?, error_msg = ? WHERE uid = ?"
                ).bind(status, r2_url || null, error_msg || null, uid).run();

                return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
            }
        }

        // Download do arquivo do R2
        if (request.method === "GET" && url.pathname.startsWith("/downloads/")) {
            const filename = url.pathname.split("/").pop();
            if (!filename) return new Response("Not found", { status: 404 });

            const object = await env.editor_storage.get(filename);
            if (!object) return new Response("File not found in R2", { status: 404 });

            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set("etag", object.httpEtag);
            headers.set("Content-Disposition", `attachment; filename="${filename}"`);

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
        let currentUid = null;
        let pollInterval = null;

        async function enviar() {
            const url = document.getElementById('url').value;
            if (!url) return alert('Insira uma URL válida');

            document.getElementById('status-box').style.display = 'block';
            document.getElementById('status-text').innerHTML = 'Enviando para a fila... <span class="spinner">⏳</span>';
            document.getElementById('link-box').innerHTML = '';

            try {
                const res = await fetch('/api/pedidos', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ youtube_url: url })
                });
                const data = await res.json();
                
                if (data.uid) {
                    currentUid = data.uid;
                    document.getElementById('status-text').innerHTML = 'Na fila, aguardando... <span class="spinner">⏳</span>';
                    pollInterval = setInterval(checkStatus, 5000);
                } else {
                    document.getElementById('status-text').innerHTML = '<span class="error">Erro ao colocar na fila.</span>';
                }
            } catch(e) {
                document.getElementById('status-text').innerHTML = '<span class="error">Erro de conexão.</span>';
            }
        }

        async function checkStatus() {
            if (!currentUid) return;
            const res = await fetch('/api/pedidos/' + currentUid);
            const data = await res.json();

            if (data.status === 'processando') {
                document.getElementById('status-text').innerHTML = 'Operador trabalhando... <span class="spinner">⚙️</span>';
            } else if (data.status === 'concluido') {
                clearInterval(pollInterval);
                document.getElementById('status-text').innerHTML = '✅ Download Pronto!';
                document.getElementById('link-box').innerHTML = \`<a href="\${data.r2_url}" class="btn-download" target="_blank">⬇️ Baixar Arquivo</a>\`;
            } else if (data.status === 'erro') {
                clearInterval(pollInterval);
                document.getElementById('status-text').innerHTML = '<span class="error">❌ Falha: ' + (data.error_msg || 'Erro desconhecido') + '</span>';
            }
        }
    </script>
</body>
</html>
`;
