/* Без ответа GitHub кнопки сохраняют ссылку на страницу последнего релиза. */
(async () => {
  const patterns = {
    silicon: /Silicon-mac\.zip$/i,
    intel: /Intel-mac\.zip$/i,
    setup: /Setup\.exe$/i,
    portable: /win\.zip$/i,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      "https://api.github.com/repos/ttpa3dhuk/CueDeck/releases/latest",
      { signal: controller.signal },
    );
    if (!response.ok) return;
    const release = await response.json();
    const assets = Array.isArray(release.assets) ? release.assets : [];
    for (const [name, pattern] of Object.entries(patterns)) {
      const asset = assets.find((item) => pattern.test(item.name));
      if (!asset) continue;
      const url = new URL(asset.browser_download_url);
      if (
        url.origin !== "https://github.com" ||
        !url.pathname.startsWith("/ttpa3dhuk/CueDeck/releases/download/")
      )
        continue;
      document.querySelectorAll(`[data-asset="${name}"]`).forEach((link) => {
        link.href = url.href;
      });
      const label = document.querySelector(`[data-size="${name}"]`);
      if (label && Number.isFinite(asset.size))
        label.textContent += ` · ${Math.round(asset.size / 1048576)} МБ`;
    }
    const meta = document.getElementById("release-meta");
    const date = new Date(release.published_at);
    if (
      meta &&
      typeof release.tag_name === "string" &&
      !Number.isNaN(date.getTime())
    ) {
      const formatted = new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
        .format(date)
        .replace(/\s*г\.$/, "");
      meta.textContent = `Версия ${release.tag_name.replace(/^v/, "")} от ${formatted}.`;
    }
  } catch (_) {
    /* Ошибка сети или лимит API: пользователь может выбрать файл на GitHub. */
  } finally {
    clearTimeout(timeout);
  }
})();

const lightbox = document.getElementById("lightbox");
const lightboxImage = document.getElementById("lightbox-img");
const lightboxCaption = document.getElementById("lightbox-caption");
let opener = null;
document.querySelectorAll("[data-image]").forEach((button) => {
  button.addEventListener("click", () => {
    opener = button;
    lightboxImage.src = button.dataset.image;
    lightboxImage.alt = button.dataset.caption || "";
    lightboxCaption.textContent = button.dataset.caption || "";
    lightbox.showModal();
    document.body.style.overflow = "hidden";
  });
});
document
  .getElementById("lightbox-close")
  .addEventListener("click", () => lightbox.close());
lightbox.addEventListener("click", (event) => {
  const bounds = lightbox.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    lightbox.close();
});
lightbox.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    lightbox.close();
  }
});
lightbox.addEventListener("close", () => {
  document.body.style.overflow = "";
  lightboxImage.removeAttribute("src");
  if (opener) opener.focus();
});

// Не запускать демонстрацию автоматически при сокращении движения в системе.
const timerVideo = document.querySelector(".timer-video");
if (
  timerVideo &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
) {
  timerVideo.autoplay = false;
  timerVideo.pause();
}
