-- Rehearsal copy of the report's inputs. Not the production schema: only the columns the report reads.
CREATE TABLE dbo.Intake (
  CaseId int IDENTITY(1,1) PRIMARY KEY, CaseType varchar(20) NOT NULL, Status varchar(20) NULL,
  SubmittedAt datetime2 NOT NULL, HouseholdSize int NOT NULL, DaysWaiting int NOT NULL, Score int NOT NULL);
GO
CREATE VIEW dbo.rpt_DailyIntake AS SELECT * FROM dbo.Intake WHERE Status <> 'Withdrawn' OR Status IS NULL;
GO
INSERT dbo.Intake (CaseType, Status, SubmittedAt, HouseholdSize, DaysWaiting, Score) VALUES
 ('SNAP',    'Open',      '2026-11-03T08:15:00.1234567', 3, 2, 41),
 ('SNAP',    'Open',      '2026-11-03T08:15:00.1234567', 3, 2, 41),
 ('MEDICAID','Review',    '2026-11-03T13:40:10.5000000', 1, 5, 17),
 ('SNAP',    'Withdrawn', '2026-11-03T15:00:00.0000000', 2, 0, 30),
 ('TANF',    NULL,        '2026-11-03T23:59:59.9999999', 4, 9, 55),
 ('TANF',    'Open',      '2026-11-04T00:00:00.0000000', 2, 1, 22),
 ('SNAP',    'Open',      '2026-11-02T10:00:00.0000000', 5, 40, 63);
GO
