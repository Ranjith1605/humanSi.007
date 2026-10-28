import os
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

def get_drive_service():
    # Looks for token in standard config path
    token_path = os.path.expanduser('~/.config/humanai/token.json')
    if not os.path.exists(token_path):
        print(f"[-] Warning: OAuth token not found at {token_path}")
        return None
    creds = Credentials.from_authorized_user_file(token_path)
    return build('drive', 'v3', credentials=creds)

def sync_state_to_drive(filename="humans_state.json", data=None):
    service = get_drive_service()
    if not service:
        print("[-] Skipping Google Drive sync (Authentication missing).")
        return
    
    file_metadata = {'name': filename}
    media_body = str(data)
    
    # Simple upload logic for agent states
    print("[*] Syncing agent state to Google Drive...")

if __name__ == "__main__":
    print("[*] Testing Google Drive integration module...")
    get_drive_service()
