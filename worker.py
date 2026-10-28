import time
from tasks import load_tasks, save_tasks

def process_queue():
    tasks = load_tasks()
    pending_tasks = [t for t in tasks if t["status"] == "pending"]
    
    if not pending_tasks:
        print("[*] No pending tasks found in queue.")
        return

    print(f"[*] Found {len(pending_tasks)} pending task(s). Processing...")
    
    for task in tasks:
        if task["status"] == "pending":
            print(f"\n[+] Executing Task [{task['id']}]: {task['title']}")
            print(f"    Description: {task['description']}")
            
            # Simulate execution work
            time.sleep(1)
            task["status"] = "completed"
            print(f"    [✔] Task [{task['id']}] marked as completed.")
            
    save_tasks(tasks)
    print("\n[*] Task batch processing finished successfully.")

if __name__ == "__main__":
    process_queue()
