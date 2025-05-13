let coins = 0;
let coinDisplay = document.getElementById('coins');
let plot = document.getElementById('plot');
let chicken = document.getElementById('chicken');
let cow = document.getElementById('cow');
let upgradeBtn = document.getElementById('upgrade');
let adBtn = document.getElementById('ad');
let multiplier = 1;

plot.onclick = () => {
  coins += 1 * multiplier;
  coinDisplay.innerText = coins;
};

chicken.onclick = () => {
  coins += 3 * multiplier;
  coinDisplay.innerText = coins;
};

cow.onclick = () => {
  coins += 5 * multiplier;
  coinDisplay.innerText = coins;
};

upgradeBtn.onclick = () => {
  if (coins >= 100) {
    coins -= 100;
    multiplier += 1;
    upgradeBtn.innerText = `Улучшить ферму (${(multiplier + 1) * 100} монет)`;
    coinDisplay.innerText = coins;
    alert('Ферма улучшена! Теперь ты получаешь больше монет.');
  } else {
    alert('Недостаточно монет для улучшения.');
  }
};

adBtn.onclick = () => {
  alert('Просмотр рекламы... 🎬');
  setTimeout(() => {
    coins += 50;
    coinDisplay.innerText = coins;
    alert('Спасибо за просмотр! Получено +50 монет.');
  }, 2000);
};
