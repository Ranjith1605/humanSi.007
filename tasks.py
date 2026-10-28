import os
import json
from datetime import datetime

TASK_FILE = "task_queue.json"

def load_tasks():
    if not os.path.exists(TASK_FILE):
        return []
    with open(TASK_FILE, "r") as f:
        return json.load(f)

def save_tasks(tasks):
    with open(TASK_FILE, "w") as f:
        json.dump(tasks, f, indent=4)

def add_task(title: str, description: str):
    tasks = load_tasks()
    new_task = {
        "id": len(tasks) + 1,
        "title": title,
        "description": description,
        "status": "pending",
        "created_at": str(datetime.now())
    }
    tasks.append(new_task)
    save_tasks(tasks)
    print(f"[+] Task Added [{new_task['id']}]: {title}")

def list_tasks():
    tasks = load_tasks()
    print("\n[*] Current humanSi.007 Task Queue:")
    for t in tasks:
        print(f"  [{t['id']}] {t['title']} - Status: {t['status']}")
    print("")

if __name__ == "__main__":
    add_task("Initialize Agent Loop", "Verify core state and local file storage.")
    list_tasks()
