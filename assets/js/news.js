const newsContainer = document.querySelector('.news-container');
const newsList = document.querySelector('.news-list');

const articles = [
  {
    "title": "Bitcoin Investors Are Plotting a Major Coup",
    "author": "Joel Khalili",
    "source": {
      "Id": "wired",
      "Name": "Wired"
    },
    "publishedAt": "2023-02-14T12:00:00Z",
    "url": "https://www.wired.com/story/crypto-bitcoin-grayscale-coup/"
  },
  {
    "title": "OnePlus Pad Android Tablet: Details, Specs, Release Date",
    "author": "Boone Ashworth",
    "source": {
      "Id": "wired",
      "Name": "Wired"
    },
    "publishedAt": "2023-02-11T14:00:00Z",
    "url": "https://www.wired.com/story/oneplus-pad-android-tablet/"
  },
  {
    "title": "Cryptoverse: Big investors edge back to bitcoin - Reuters",
    "author": null,
    "source": {
      "Id": "reuters",
      "Name": "Reuters"
    },
    "publishedAt": "2023-01-31T06:01:08Z",
    "url": "https://www.reuters.com/technology/cryptoverse-big-investors-edge-back-bitcoin-2023-01-31/"
  }
];

if (articles.length > 0) {
  articles.forEach(article => {
    const newsItem = document.createElement('li');
    newsItem.classList.add('news-item');

    const newsTitle = document.createElement('h3');
    newsTitle.classList.add('news-title');
    newsTitle.textContent = article.title;

    const newsAuthor = document.createElement('div');
    newsAuthor.classList.add('news-author');
    newsAuthor.textContent = article.author ? `Author: ${article.author}` : '';

    const newsSource = document.createElement('div');
    newsSource.classList.add('news-source');
    newsSource.textContent = article.source.Name;

    const newsDate = document.createElement('div');
    newsDate.classList.add('news-date');
    newsDate.textContent = new Date(article.publishedAt).toDateString();

    const newsLink = document.createElement('a');
    newsLink.classList.add('news-link');
    newsLink.textContent = 'Read More';
    newsLink.href = article.url;
    newsLink.target = '_blank';

    newsItem.appendChild(newsTitle);
    newsItem.appendChild(newsAuthor);
    newsItem.appendChild(newsSource);
    newsItem.appendChild(newsDate);
    newsItem.appendChild(newsLink);

    newsList.appendChild(newsItem);
  });
} else {
  const noNews = document.createElement('p');
  noNews.textContent = 'No news articles found';
  newsContainer.appendChild(noNews);
}

