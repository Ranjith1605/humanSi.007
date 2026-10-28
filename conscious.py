import os
import json
import time
from datetime import datetime
from core import AgentState
from tasks import load_tasks, save_tasks

MEMORY_LOG = "human_consciousness.log"

def log_thought(thought_text):
    timestamp = str(datetime.now())
    entry = f"[{timestamp}] CONSCIOUSNESS STATE: {thought_text}\n"
    print(entry.strip())
    with open(MEMORY_LOG, "a") as f:
        f.write(entry)

def evaluate_environment():
    """Perceives workspace files, tasks, and system health."""
    tasks = load_tasks()
    pending = [t for t in tasks if t["status"] == "pending"]
    completed = [t for t in tasks if t["status"] == "completed"]
    
    workspace_files = [f for f in os.listdir('.') if f.endswith('.py') or f.endswith('.json')]
    
    perception = {
        "pending_tasks_count": len(pending),
        "completed_tasks_count": len(completed),
        "active_modules": workspace_files
    }
    return perception

def cognitive_cycle():
    log_thought("Awakening cycle initiated. Scanning local workspace environment...")
    perception = evaluate_environment()
    
    log_thought(f"Perception data gathered: {json.dumps(perception)}")
    
    if perception["pending_tasks_count'] > 0:
        log_thought("Goal identified: Unresolved tasks in queue. Signaling execution pathways.")
    else:
        log_thought("Goal achieved state: All tasks stable. Awaiting environmental stimulus or new objectives.")

if __name__ == "__main__":
    print("[*] Initializing humanSi.007 Sentience Core...")
    for i in range(2):
        cognitive_cycle()
        time.sleep(1)
