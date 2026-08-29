-- Local development seed: a small catalogue (embeddings are filled by the
-- `embed-media` Edge Function) plus "When It Gets Good" engagement data.

insert into public.media_items
  (tmdb_id, media_type, title, original_title, overview, poster_path, backdrop_path, genres, runtime_minutes, release_year, vote_average, popularity, origin_country)
values
  (1396, 'tv', 'Breaking Bad', 'Breaking Bad',
   'A chemistry teacher diagnosed with cancer teams up with a former student to secure his family''s future by cooking methamphetamine.',
   '/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg', '/9faGSFi5jam6pDWGNd0p8JcJgXQ.jpg',
   '{Drama,Crime}', 47, 2008, 8.9, 450.1, '{US}'),
  (136315, 'tv', 'The Bear', 'The Bear',
   'A young chef from the fine dining world returns to Chicago to run his family''s sandwich shop.',
   '/sHFlbKS3WLqMnp9t2ghADIJFnuQ.jpg', '/9Lg2vNmirVdhZZrJZLZOePGBoCn.jpg',
   '{Comedy,Drama}', 30, 2022, 8.3, 310.7, '{US}'),
  (71035, 'tv', 'Fauda', 'פאודה',
   'An elite undercover Israeli unit pursues a Hamas operative believed to be dead, blurring every moral line along the way.',
   '/dGgaSJserJUGvhicdOEZeQpEmB.jpg', '/9ZM6RpNSMOB8bDbBAOfEye133m4.jpg',
   '{Drama,Action,War}', 45, 2015, 7.5, 120.4, '{IL}'),
  (155, 'movie', 'The Dark Knight', 'The Dark Knight',
   'Batman raises the stakes in his war on crime as the Joker plunges Gotham into anarchy.',
   '/qJ2tW6WMUDux911r6m7haRef0WH.jpg', '/hqkIcbrOHL86UncnHIsHVcVmzue.jpg',
   '{Action,Crime,Drama}', 152, 2008, 8.5, 520.9, '{US}'),
  (550988, 'movie', 'Free Guy', 'Free Guy',
   'A bank teller discovers he is a background player in an open-world video game and decides to become the hero of his own story.',
   '/xmbU4JTUm8rsdtn7Y3Fcm30GpeT.jpg', '/8Y43POKjjKDGI9MH89NW0NAzzp8.jpg',
   '{Comedy,Action,Science Fiction}', 115, 2021, 7.5, 280.2, '{US}'),
  (96677, 'tv', 'Lupin', 'Lupin',
   'Inspired by the adventures of Arsène Lupin, gentleman thief Assane Diop sets out to avenge his father.',
   '/sgxawbFB5Vi5OkPWQLNfl3dvkNJ.jpg', '/6qkvXdRPLwWrgSyxHrbxDbGYwzR.jpg',
   '{Crime,Drama,Mystery}', 47, 2021, 7.8, 190.3, '{FR}'),
  (87739, 'tv', 'Shtisel', 'שטיסל',
   'A Haredi family in Jerusalem navigates love, loss and longing between tradition and modern life.',
   '/tYbjPzOzgkhdGyygqZbGVGXhTB5.jpg', '/kdHK5cnnp3vTLQ8CYdOM2lZmZlI.jpg',
   '{Drama}', 45, 2013, 7.9, 45.6, '{IL}');

-- "When It Gets Good" spikes (score is normalized 0..1 engagement).
insert into public.engagement_points (media_item_id, season, episode, minute, score, source)
select m.id, v.season, v.episode, v.minute, v.score, v.source::public.engagement_source
from (
  values
    (1396, 1, 1, 8,  0.35, 'ai'),
    (1396, 1, 2, 20, 0.42, 'ai'),
    (1396, 1, 4, 12, 0.91, 'ai'),        -- the canonical "it takes off here"
    (1396, 1, 6, 30, 0.88, 'community'),
    (1396, 2, 1, 5,  0.72, 'community'),
    (136315, 1, 1, 10, 0.55, 'ai'),
    (136315, 1, 7, 1,  0.97, 'community'), -- one-take episode
    (71035, 1, 1, 14, 0.61, 'ai'),
    (71035, 1, 3, 22, 0.86, 'community'),
    (87739, 1, 2, 18, 0.64, 'community'),
    (96677, 1, 1, 25, 0.70, 'ai')
) as v(tmdb_id, season, episode, minute, score, source)
join public.media_items m on m.tmdb_id = v.tmdb_id and m.media_type = 'tv';
