const starField = document.querySelector('.welcome-stars');

if (starField) {
  const random = (min, max) => min + Math.random() * (max - min);
  const stars = document.createDocumentFragment();
  for (let i = 0; i < 16; i++) {
    const star = document.createElement('span');
    const duration = random(6, 12);
    star.style.left = `${random(3, 97)}%`;
    star.style.top = `${random(5, 95)}%`;
    star.style.fontSize = `${random(7, 13)}px`;
    star.style.setProperty('--star-x', `${random(-26, 26)}px`);
    star.style.setProperty('--star-y', `${random(-30, 30)}px`);
    star.style.animationDuration = `${duration}s`;
    star.style.animationDelay = `${-random(0, duration)}s`;
    stars.append(star);
  }
  starField.append(stars);
}
