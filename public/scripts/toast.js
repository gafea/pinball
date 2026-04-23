// https://www.geeksforgeeks.org/javascript/how-to-make-a-toast-notification-in-html-css-and-javascript/

let icon = {
  success: '<span class="material-symbols-outlined">task_alt</span>',
  error: '<span class="material-symbols-outlined">error</span>',
  warning: '<span class="material-symbols-outlined">warning</span>',
  info: '<span class="material-symbols-outlined">info</span>',
};

/**
 * Displays a toast notification with the given message, type, and duration.
 * @param {string} message - The message to display in the toast.
 * @param {string} toastType - The type of toast (e.g., "success", "error", "warning", "info").
 * @param {number} duration - The duration (in milliseconds) for which the toast should be visible.
 */
const showToast = (
  message = "Sample Message",
  toastType = "info",
  duration = 5000,
) => {
  if (!Object.keys(icon).includes(toastType)) {
    toastType = "info";
  }

  let container = document.getElementById("toast-container");

  let box = document.createElement("div");
  box.classList.add("toast", `toast-${toastType}`);
  box.innerHTML = `<div class="toast-content-wrapper">
                        <div class="toast-icon">
                            ${icon[toastType]}
                        </div>
                        <div class="toast-message">${message}</div>
                        <div class="toast-progress"></div>
                    </div>`;

  box.style.animationDelay = `0s, ${duration / 1000}s`;
  box.querySelector(".toast-progress").style.animationDuration =
    `${duration / 1000}s`;

  let removeTimer = setTimeout(() => {
    box.remove();
  }, duration + 500); // 0.5s for fade out animation

  // click to dismiss immediately
  box.addEventListener("click", () => {
    clearTimeout(removeTimer);
    box.classList.add("closing");
    box.addEventListener("animationend", () => {
      box.remove();
    });
  });

  container.appendChild(box);
};
