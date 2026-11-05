using System;
using System.Configuration;
using System.Data.SqlClient;
using System.Web.UI;

namespace Agency.Intake
{
    public partial class Review : Page
    {
        protected void Page_Load(object sender, EventArgs e)
        {
            if (IsPostBack) return;
            using (var cn = new SqlConnection(ConfigurationManager.ConnectionStrings["IntakeDb"].ConnectionString))
            using (var cmd = new SqlCommand(
                "SELECT CaseId, CaseType, Status, DaysWaiting " +
                "FROM dbo.Intake WHERE Status = 'NEW' ORDER BY SubmittedAt", cn))
            {
                cn.Open();
                var rd = cmd.ExecuteReader();
                while (rd.Read()) { Queue.Add(rd.GetInt32(0), rd.GetString(2)); }
            }
            ViewState["Filter"] = "NEW";
        }

        protected void Approve_Click(object sender, EventArgs e)
        {
            var sql = "UPDATE dbo.Intake SET Status = 'FAST_TRACK' WHERE CaseId = @id";
            using (var cn = new SqlConnection(ConfigurationManager.ConnectionStrings["IntakeDb"].ConnectionString))
            using (var cmd = new SqlCommand(sql, cn)) { cn.Open(); cmd.ExecuteNonQuery(); }
        }

        protected void Filter_Changed(object sender, EventArgs e)
        {
            var sql = "SELECT CaseId, Status FROM dbo.Intake WHERE " + ClauseFor(FilterList.SelectedValue);
            using (var cn = new SqlConnection(ConfigurationManager.ConnectionStrings["IntakeDb"].ConnectionString))
            using (var cmd = new SqlCommand(sql, cn)) { cn.Open(); }
        }
    }
}
