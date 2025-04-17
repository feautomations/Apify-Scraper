const { PlaywrightCrawler, enqueueLinks } = require('crawlee');

const crawler = new PlaywrightCrawler({
    requestQueue: await PlaywrightCrawler.openRequestQueue(),
    maxConcurrency: 2,
    maxRequestRetries: 3,
    headless: true,
    navigationTimeoutSecs: 120,
    browserPoolOptions: {
        useChrome: true,
    },
    preNavigationHooks: [
        async ({ page }) => {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
            await page.route('**/*.{png,jpg,jpeg,gif,webp,css}', route => route.abort());
        },
    ],
    async requestHandler({ request, page, log, enqueueLinks }) {
        log.info(`📍 Scraping: ${request.url}`);

        const isPropertyDetailPage = request.url.includes('/en/plp/');

        if (!isPropertyDetailPage) {
            const propertyType = await page.evaluate(() => {
                const dropdownElement = document.querySelector('button[data-testid="filters-form-dropdown-category-type"] span');
                let propertyType = dropdownElement ? dropdownElement.innerText?.trim() : '';
                if (propertyType.toLowerCase().includes('buy')) {
                    propertyType = propertyType.toLowerCase().includes('commercial') ? 'Commercial Buy' : 'Buy';
                } else if (propertyType.toLowerCase().includes('rent')) {
                    propertyType = propertyType.toLowerCase().includes('commercial') ? 'Commercial Rent' : 'Rent';
                } else {
                    propertyType = '';
                }
                return propertyType;
            });
            log.info(`Extracted propertyType from dropdown: ${propertyType}`);

            await page.evaluate(async () => {
                await new Promise(resolve => {
                    let totalHeight = 0;
                    const distance = 300;
                    const timer = setInterval(() => {
                        window.scrollBy(0, distance);
                        totalHeight += distance;

                        if (totalHeight >= document.body.scrollHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 500);
                });
            });

            const listings = await page.evaluate((sourceUrl, propertyType) => {
                const articles = Array.from(document.querySelectorAll('article'));
                return articles.map((card, index) => {
                    const title = card.querySelector('h2, .card__title')?.innerText?.trim() || '';
                    const price = card.querySelector('[class*="price"]')?.innerText?.trim() || '';
                    const location = card.querySelector('[class*="location"]')?.innerText?.trim() || '';
                    const image = card.querySelector('img')?.src || '';

                    const titleElement = card.querySelector('a.property-card-module_property-card__link__L6AKb');
                    const fullTitle = titleElement ? titleElement.getAttribute('title')?.trim() : '';
                    const specificPropertyType = fullTitle ? fullTitle.split('-')[0]?.trim() : '';

                    const listingUrl = titleElement ? titleElement.href : '';

                    let bedrooms = '';
                    let bathrooms = '';
                    let squareFootage = '';
                    if (fullTitle) {
                        const parts = fullTitle.split('-').map(part => part.trim());
                        for (const part of parts) {
                            if (part.includes('Bedroom')) {
                                bedrooms = part.match(/\\d+/)?.[0] || '';
                            }
                            if (part.includes('Bathroom')) {
                                bathrooms = part.match(/\\d+/)?.[0] || '';
                            }
                        }
                    }

                    const detailsElements = card.querySelectorAll('p');
                    for (const element of detailsElements) {
                        const text = element.innerText?.trim().toLowerCase();
                        if (text.includes('sqft') || text.includes('sq ft') || text.includes('square feet')) {
                            squareFootage = text.match(/\\d+,?\\d+/)?.[0]?.replace(',', '') || '';
                            break;
                        }
                    }

                    return {
                        title: title,
                        price: price,
                        location: location,
                        image: image,
                        specificPropertyType: specificPropertyType,
                        propertyType: propertyType,
                        sourceUrl: sourceUrl,
                        listingUrl: listingUrl,
                        bedrooms: bedrooms,
                        bathrooms: bathrooms,
                        squareFootage: squareFootage,
                        description: ''
                    };
                });
            }, request.url, propertyType);

            log.info(`Found ${listings.length} articles`);

            const uniqueListings = [];
            const seenTitles = new Set();
            for (const listing of listings) {
                if (!seenTitles.has(listing.title) && listing.listingUrl) {
                    seenTitles.add(listing.title);
                    uniqueListings.push(listing);
                    await request.queue.addRequest({ url: listing.listingUrl, userData: { listingData: listing } });
                }
            }

            log.info(`After deduplication, added ${uniqueListings.length} listings to queue for description scraping`);

            await enqueueLinks({
                selector: 'a[aria-label="Next"]',
                requestQueue: request.queue,
            });

            await page.waitForTimeout(2000);
        } else {
            const listingData = request.userData.listingData;
            log.info(`Scraping description for: ${listingData.title}`);

            try {
                await page.waitForSelector('article[data-testid="dynamic-sanitize-html"]', { timeout: 15000 });

                const description = await page.evaluate(() => {
                    const descElement = document.querySelector('article[data-testid="dynamic-sanitize-html"]');
                    return descElement ? descElement.innerText.trim() : '';
                });

                listingData.description = description || 'No description available';
                log.info(`Extracted description for ${listingData.title}: ${listingData.description.substring(0, 100)}...`);

                await crawler.pushData(listingData);
            } catch (error) {
                log.error(`Failed to scrape description for ${listingData.title}: ${error.message}`);
                listingData.description = 'Failed to scrape description';
                await crawler.pushData(listingData);
            }

            await page.waitForTimeout(2000);
        }
    },
    async failedRequestHandler({ request, error }) {
        console.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.requestQueue.addRequest({ url: 'https://www.propertyfinder.ae/en/broker/golden-white-real-estate-management-10350?properties%5Bfilter%5Bcategory_id%5D%5D=1' });
await crawler.requestQueue.addRequest({ url: 'https://www.propertyfinder.ae/en/broker/golden-white-real-estate-management-10350?properties%5Bfilter%5Bcategory_id%5D%5D=2' });
await crawler.requestQueue.addRequest({ url: 'https://www.propertyfinder.ae/en/broker/golden-white-real-estate-management-10350?properties%5Bfilter%5Bcategory_id%5D%5D=3' });
await crawler.requestQueue.addRequest({ url: 'https://www.propertyfinder.ae/en/broker/golden-white-real-estate-management-10350?properties%5Bfilter%5Bcategory_id%5D%5D=4' });

await crawler.run();
