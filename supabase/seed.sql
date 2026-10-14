-- Optional: the STAT 1201 midterm course shown first in the library.
-- Questions are served from data/stat1201-questions.json in this repo.
-- The owner is a placeholder id, so nobody can edit or delete it from the app.
insert into public.courses (owner,title,subject,status,stage,published,seeded,author,spec)
values ('00000000-0000-0000-0000-000000000000','STAT 1201 midterm (Columbia)','Probability and statistics',
        'ready','ready',true,true,'James Floyd',
        '{"kind":"static","url":"data/stat1201-questions.json"}'::jsonb);
