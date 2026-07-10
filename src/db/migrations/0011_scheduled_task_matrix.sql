-- Weekly schedule matrix for recurring tasks: JSON array of 7 arrays (index 0 =
-- Monday) of 24 ints (0/1); an enabled cell fires one run at the top of that
-- local hour. Mutually exclusive with schedule_unit/schedule_amount (enforced
-- in the app layer). NULL = not using weekly mode.
ALTER TABLE scheduled_tasks ADD COLUMN schedule_matrix TEXT;
