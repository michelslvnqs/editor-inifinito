import os
import yt_dlp

def download_youtube_video(youtube_id, output_dir="downloads", subtitle_lang=None):
    """
    Baixa um vídeo do YouTube em até 360p pre-muxed (vídeo + áudio juntos).
    Também baixa legendas se subtitle_lang for especificado.
    Retorna (caminho_do_video, titulo, caminho_da_legenda)
    """
    os.makedirs(output_dir, exist_ok=True)
    url = f"https://www.youtube.com/watch?v={youtube_id}"
    
    print(f"[{youtube_id}] Verificando/Baixando arquivo base completo...")
    output_template = os.path.join(output_dir, f"{youtube_id}.%(ext)s")
    
    ydl_opts = {
        'format': 'best[height<=360]',
        'outtmpl': output_template,
        'quiet': True,
        'no_warnings': True,
    }
    
    if subtitle_lang:
        ydl_opts['writesubtitles'] = True
        ydl_opts['subtitleslangs'] = [subtitle_lang]
        ydl_opts['writeautomaticsub'] = True
    
    title = youtube_id
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = info.get('title', youtube_id)
        
    video_path = None
    subtitle_path = None
    
    for f in os.listdir(output_dir):
        if f.startswith(youtube_id + ".") and not f.startswith(youtube_id + "_") and not f.endswith(".vtt"):
            video_path = os.path.join(output_dir, f)
            
        if subtitle_lang and f.startswith(youtube_id + ".") and f.endswith(".vtt") and subtitle_lang in f:
            subtitle_path = os.path.join(output_dir, f)
            
    if subtitle_lang and not subtitle_path:
        for f in os.listdir(output_dir):
            if f.startswith(youtube_id + ".") and f.endswith(".vtt"):
                subtitle_path = os.path.join(output_dir, f)
                break
                
    if not video_path:
        raise Exception(f"Falha ao localizar o arquivo baixado para {youtube_id}")
        
    return video_path, title, subtitle_path
