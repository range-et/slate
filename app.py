from flask import Flask, send_from_directory, Response
import mimetypes
import os

# Ensure Flask knows about .js MIME type
mimetypes.add_type('application/javascript', '.js')

app = Flask(__name__, static_folder='dist', static_url_path='/')

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve(path):
    if path != "" and os.path.exists(os.path.join(app.static_folder, path)):
        full_path = os.path.join(app.static_folder, path)
        mime_type, _ = mimetypes.guess_type(full_path)
        with open(full_path, 'rb') as f:
            content = f.read()
        return Response(content, mimetype=mime_type)
    else:
        return send_from_directory(app.static_folder, 'index.html')

if __name__ == "__main__":
    app.run(debug=True)
